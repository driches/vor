/**
 * Drive the existing src/orchestrator.runOrchestrator against a LoadedCase
 * instead of a real GitHub PR.
 *
 * Strategy (Task 6):
 *   - The orchestrator's `providerFactory` input lets us inject a scripted
 *     `FakeProvider` (implements LLMProvider) without mocking
 *     `@anthropic-ai/sdk` or `openai` at module scope. Same shape works for
 *     any provider — Anthropic, OpenAI, or a future addition — no per-vendor
 *     mock duplication.
 *   - `@octokit/rest` and its plugins still get mocked at module scope because
 *     they're orthogonal to LLM provider plumbing: the case's `files[]` are
 *     served via the mocked `repos.getContent` and a synthesized unified diff
 *     is served via `pulls.get(mediaType:'diff')`.
 *
 * CAUTION: this file installs vi.mock at module scope for octokit only. It is
 * TEST-ONLY — importing from production code would replace those modules
 * globally. Only import from scripts/eval/*.test.ts.
 */
import { vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import type { LoadedCase } from './case-loader.js';
import { synthesizeDiff } from './diff-synthesis.js';
import type { RunRecord } from './types.js';
import type { ReviewConfig } from '../../src/config/types.js';
import { type Severity, type Category, type Confidence, CATEGORIES } from '../../src/types.js';
import { MODEL_PRICING } from '../../src/util/pricing.js';
import {
  inferProviderFromModel,
  inputTokensFullRateFor,
  type CanonicalMessage,
  type CanonicalTool,
  type CanonicalUsage,
  type CompleteOptions,
  type CompleteResponse,
  type LLMProvider,
  type ProviderId,
} from '../../src/llm/index.js';

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'important', 'minor', 'nit']);
const VALID_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

// MODEL_PRICING lives in src/util/pricing.ts so the production runner and
// this test-only harness share one source of truth. See PR #13.

function computeCostUsd(cost: AdapterState['costAccum'], model: string): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // The eval harness's purpose is cost comparison; silently falling back
    // to a synthetic `turns * 0.01` estimate produces report cells that
    // LOOK valid but mis-rank configs on the cost axis. Throw so a typo
    // or newly-introduced model id fails the eval run rather than
    // corrupting metrics. See PR #10 Codex P2 3295074807.
    throw new Error(
      `computeCostUsd: no pricing entry for model "${model}". ` +
        `Known models: ${Object.keys(MODEL_PRICING).join(', ')}. ` +
        `Add an entry to MODEL_PRICING (with the correct per-million rates) ` +
        `or fix the model name in your pipeline config.`,
    );
  }
  // `cache_creation` / `cache_read` are optional on ModelPricing now that
  // OpenAI rows landed (OpenAI cache writes are free). Guard with `?? 0` so
  // a missing rate contributes nothing instead of NaN-poisoning the report.
  return (
    (cost.input_tokens * pricing.input) / 1_000_000 +
    (cost.output_tokens * pricing.output) / 1_000_000 +
    (cost.cache_creation_input_tokens * (pricing.cache_creation ?? 0)) / 1_000_000 +
    (cost.cache_read_input_tokens * (pricing.cache_read ?? 0)) / 1_000_000
  );
}

interface AdapterState {
  caseFiles: Map<string, string>;
  caseDiff: string;
  filesApi: Array<{ filename: string; changes: number; patch: string | null | undefined }>;
  createReviewCalls: Array<{ args: Record<string, unknown> }>;
  costAccum: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    turns: number;
  };
}

// LIMITATION: This module-scope state is shared across calls. v1's CLI and
// integration tests only invoke evalRun sequentially, so this is safe today.
// Concurrent invocations (e.g. Promise.all over multiple configs) would
// corrupt each other's runs. If we ever need concurrent eval, restructure
// to per-call state passed through a closure or pass-by-context. Tracking
// as a known limitation rather than fixing speculatively. See PR #10
// comment 3294915014.
const state: AdapterState = {
  caseFiles: new Map(),
  caseDiff: '',
  filesApi: [],
  createReviewCalls: [],
  costAccum: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: 0,
  },
};

// Concurrency guard: see LIMITATION comment above. Module-scope `state` is not
// safe for parallel evalRun calls — fail fast rather than silently corrupting.
let runActive = false;

/**
 * Scripted provider for the eval harness. Pops one canonical response per
 * `complete()` call and accumulates usage into the module-scope `state.costAccum`
 * so the existing per-model `computeCostUsd` pass keeps working unchanged.
 *
 * The `id` field is set per-run based on the resolved provider id for the
 * configured model — the runner reads `provider.id` for logging only, but
 * keeping it accurate avoids confusing eval-side debug output.
 */
export class FakeProvider implements LLMProvider {
  readonly id: ProviderId;
  private readonly script: CompleteResponse[];
  public completeCalls = 0;
  constructor(id: ProviderId, script: CompleteResponse[]) {
    this.id = id;
    // Copy so each evalRun gets a fresh, mutable queue and external callers
    // can't drain ours by reusing the array.
    this.script = [...script];
  }
  async complete(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
    _opts: CompleteOptions,
  ): Promise<CompleteResponse> {
    this.completeCalls += 1;
    const next = this.script.shift();
    if (!next) {
      throw new Error('agentScript exhausted — test did not script enough turns');
    }
    // Mirror the per-turn token accumulation the old SDK mock did, with the
    // same provider-aware input normalization the runner applies via
    // `inputTokensFullRate`. Without this, an OpenAI script with non-zero
    // cache_read_tokens would double-charge the cached portion in
    // `computeCostUsd` (which bills `input_tokens * input_rate +
    // cache_read_input_tokens * cache_read_rate`), mis-ranking configs by
    // cost on cache-heavy runs. Codex P2 #3300723609 — same shape as the
    // runner bug fixed in cb3c820, just in the eval accumulator this time.
    state.costAccum.turns += 1;
    state.costAccum.input_tokens += this.inputTokensFullRate(next.usage);
    state.costAccum.output_tokens += next.usage.output_tokens;
    state.costAccum.cache_read_input_tokens += next.usage.cache_read_tokens ?? 0;
    state.costAccum.cache_creation_input_tokens += next.usage.cache_creation_tokens ?? 0;
    return next;
  }
  /**
   * Delegates to the shared `inputTokensFullRateFor` helper so the eval
   * harness, the runner, the real adapters, and any test FakeProvider
   * all share one formula. Without this, a future change to the rule
   * (e.g. a third provider) would need to touch four call sites in
   * lockstep — PR #20 self-review #3300871789.
   */
  inputTokensFullRate(usage: CanonicalUsage): number {
    return inputTokensFullRateFor(this.id, usage);
  }
}

vi.mock('@octokit/rest', () => {
  class FakeOctokit {
    public rest: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    constructor() {
      this.rest = {
        pulls: {
          get: vi.fn(async (args: { mediaType?: { format?: string } }) => {
            if (args.mediaType?.format === 'diff') {
              return { data: state.caseDiff as unknown };
            }
            return {
              data: {
                number: 1,
                title: 'Eval run',
                body: '',
                user: { login: 'eval' },
                draft: false,
                additions: 1,
                deletions: 0,
                changed_files: state.filesApi.length,
                labels: [],
                head: { sha: 'evalhead', ref: 'feature' },
                base: { sha: 'evalbase', ref: 'main' },
              },
            };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listFiles: vi.fn(async () => ({
            data: state.filesApi,
          })) as unknown as (...args: unknown[]) => Promise<unknown>,
          createReview: vi.fn(async (args: Record<string, unknown>) => {
            state.createReviewCalls.push({ args });
            return { data: { id: 12345 } };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listReviews: vi.fn(async () => ({ data: [] })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
          listReviewComments: vi.fn(async () => ({ data: [] })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
          dismissReview: vi.fn(async () => ({ data: {} })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
        },
        repos: {
          getContent: vi.fn(async (args: { path: string }) => {
            const content = state.caseFiles.get(args.path);
            if (content == null) {
              const err = Object.assign(new Error('Not Found'), { status: 404 });
              throw err;
            }
            return {
              data: {
                type: 'file',
                content: Buffer.from(content, 'utf-8').toString('base64'),
                encoding: 'base64',
              },
            };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
        },
      };
    }
    static plugin() {
      return FakeOctokit;
    }
  }
  return { Octokit: FakeOctokit };
});

// Plugin modules pulled in by createOctokit are no-ops in this context.
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }));

// Import runOrchestrator AFTER the octokit mocks above are registered.
import { runOrchestrator } from '../../src/orchestrator.js';

export interface EvalRunInput {
  case: LoadedCase;
  config: ReviewConfig;
  /**
   * API key for the resolved provider. The adapter looks at
   * `config.model` (and `config.provider` override if present) to figure
   * out which provider this key belongs to and routes it accordingly.
   */
  apiKey: string;
  /**
   * One canonical response per turn the agent will take. Provider-agnostic —
   * the eval harness drives the runner via an injected `FakeProvider`, not
   * via per-vendor SDK mocks.
   */
  agentScript: CompleteResponse[];
}

export interface EvalRunOutput {
  findings: RunRecord['findings'];
  cost: RunRecord['cost'];
}

export async function evalRun(input: EvalRunInput): Promise<EvalRunOutput> {
  // Pre-flight: reject unknown model ids BEFORE we spend any API tokens.
  // The same check fires inside `computeCostUsd` at the end of the run, but
  // at that point we've already paid for a full orchestrator pass against
  // a real model and then discarded the findings — wasted money and time
  // for a typo'd config. Validate at the top so the failure mode is fast
  // and cheap. See PR #10 dogfood MINOR 3295239967.
  if (!MODEL_PRICING[input.config.model]) {
    throw new Error(
      `evalRun: no pricing entry for model "${input.config.model}". ` +
        `Known models: ${Object.keys(MODEL_PRICING).join(', ')}. ` +
        `Add an entry to MODEL_PRICING (with the correct per-million rates) ` +
        `or fix the model name in your pipeline config.`,
    );
  }
  if (runActive) {
    throw new Error(
      'evalRun does not support concurrent invocations — module-scope state would corrupt across calls. Use sequential calls only (see LIMITATION comment near `state`).',
    );
  }
  runActive = true;
  try {
    // Resolve the provider once so we know which side of the apiKey slot to
    // populate and which provider id to stamp on the FakeProvider. Same
    // resolution rules as the production orchestrator: explicit
    // `config.provider` override wins; otherwise infer from the model id.
    const providerId: ProviderId =
      input.config.provider ?? inferProviderFromModel(input.config.model);
    const fake = new FakeProvider(providerId, input.agentScript);

    // Reset shared state for this run.
    state.caseFiles = new Map(input.case.files.map((f) => [f.path, f.content]));
    const { diff, filesApi } = synthesizeDiff(input.case);
    state.caseDiff = diff;
    state.filesApi = filesApi;
    state.createReviewCalls = [];
    state.costAccum = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      turns: 0,
    };

    // The orchestrator's loadConfig will look for .vor.yml at HEAD; we
    // serve a serialized form of the supplied config so the orchestrator picks
    // up exactly what the test asked for.
    //
    // Force-disable `experimental.worker_delegation` for the eval-run
    // sandbox: the providerFactory injection only stubs `provider.complete()`
    // on the MAIN agent loop. The pre-flight Haiku call and the
    // worker_check_usage_claim tool both construct their own real
    // `new Anthropic({ apiKey })` instances inside runAgent — meaning a
    // case config with worker_delegation.enabled = true would hit the live
    // Anthropic API (or fail outright with the dummy `sk-ant-test` key),
    // bypassing the sandbox and skewing eval results. We deep-clone the
    // config first so the caller's object isn't mutated. Codex P2
    // #3300812876.
    const sandboxedConfig: ReviewConfig = JSON.parse(JSON.stringify(input.config)) as ReviewConfig;
    sandboxedConfig.experimental.worker_delegation.enabled = false;
    state.caseFiles.set('.vor.yml', serializeConfigAsYaml(sandboxedConfig));

    const wallStart = Date.now();
    // Do NOT swallow runOrchestrator exceptions. Converting them into a
    // synthetic `ended_reason: 'error: ...'` and continuing would let the
    // resulting run flow through scoring with an empty `findings` array,
    // and every truth would score as FN — making a transient API/infra
    // failure look like a model recall regression in the eval report.
    // Let the exception propagate; the CLI caller (golden:eval) decides
    // whether to log-and-skip vs abort the matrix. See PR #10 Codex P1
    // 3295104167.
    const out = await runOrchestrator({
      owner: 'eval',
      repo: 'eval',
      pull_number: 1,
      // Only populate the slot that matches the resolved provider. The other
      // stays empty — the orchestrator's fork-safety check would otherwise
      // trip if the wrong key were placed where the model expects it.
      anthropic_api_key: providerId === 'anthropic' ? input.apiKey : '',
      openai_api_key: providerId === 'openai' ? input.apiKey : '',
      github_token: 'gh-test',
      config_path: '.vor.yml',
      dry_run: false,
      workspace_dir: '/tmp/eval',
      // Inject the scripted FakeProvider. The orchestrator forwards this to
      // runAgent which uses it instead of `createProvider`. Real vendor SDKs
      // are never instantiated in eval runs.
      providerFactory: () => fake,
    });
    const endedReason = out.ended;
    const wall_ms = Math.max(1, Date.now() - wallStart);

    // Flatten comments across ALL createReview calls. Production posts exactly
    // one review per run, but a future refactor that splits posting (e.g. AI
    // vs scanner findings into separate reviews) would silently drop everything
    // past the first call if we only read `createReviewCalls[0]`, causing
    // artificially low TPs without any signal. See PR #10 comment 3295052517.
    const allComments = state.createReviewCalls.flatMap(
      (call) => (call.args as { comments?: Array<Record<string, unknown>> }).comments ?? [],
    );
    const findings: RunRecord['findings'] = allComments.map(reconstructFinding);

    return {
      findings,
      cost: {
        provider: providerId,
        ...state.costAccum,
        cost_usd: computeCostUsd(state.costAccum, input.config.model),
        wall_ms,
        ended_reason: endedReason,
      },
    };
  } finally {
    runActive = false;
  }
}

/**
 * Reconstruct a `PostedComment` from one of the `createReview` payload
 * entries the orchestrator captured. Splits out so it's directly unit-testable
 * — the inline-map version was hard to exercise for edge cases like the
 * multi-line `start_line` preservation contract.
 *
 * Exported for tests; production callers go through `evalRun`.
 */
export function reconstructFinding(c: Record<string, unknown>): RunRecord['findings'][number] {
  const body = typeof c.body === 'string' ? c.body : '';
  const parsed = parseRenderedComment(body);
  // Preserve `start_line` for multi-line review comments. scoreRun treats a
  // finding as the range [start_line ?? line, line]; dropping start_line
  // here would collapse every multi-line finding back to a single-line
  // anchor and defeat the range-overlap matching added in Fix N. See PR #10
  // Codex P2 3295082015.
  const start_line = typeof c.start_line === 'number' ? c.start_line : undefined;
  return {
    severity: parsed.severity,
    file_path: c.path as string,
    line: c.line as number,
    ...(start_line !== undefined ? { start_line } : {}),
    side: (c.side as 'RIGHT' | 'LEFT') ?? 'RIGHT',
    category: parsed.category,
    title: parsed.title,
    why_it_matters: parsed.why_it_matters,
    confidence: parsed.confidence,
  } satisfies RunRecord['findings'][number];
}

// `synthesizeDiff` is re-exported (not redefined) so external tooling
// (scripts/eval/synthetic-real.ts, CLIs) can import the diff synthesizer
// without dragging in this module's `vi.mock` calls, which throw outside
// the vitest runtime.
export { synthesizeDiff } from './diff-synthesis.js';

/**
 * Recover severity / category / title / why-it-matters / confidence from the
 * rendered comment body that `src/github/review-poster.ts:renderCommentBody`
 * produces.
 *
 * Shape (from renderCommentBody):
 *   **[<SEVERITY> · <category>( · medium confidence | · low confidence)?]** <title>
 *
 *   <why_it_matters>
 *   [optional ```suggestion ... ``` block]
 *   [optional `_via <scanner>_` provenance tag]
 *
 * We parse the bracketed tag to recover the structured fields. The text
 * after the tag (on the same line) is the title; the next paragraph is
 * why_it_matters. If parsing fails we fall back to sane defaults so a
 * malformed body still produces *something* downstream rather than throwing.
 */
function parseRenderedComment(body: string): {
  severity: Severity;
  category: Category;
  confidence: Confidence;
  title: string;
  why_it_matters: string;
} {
  const headingMatch = body.match(/^\*\*\[([^\]]+)\]\*\*\s*(.*)$/m);
  let severity: Severity = 'minor';
  let category: Category = 'security';
  // `renderCommentBody` tags both `low confidence` and `medium confidence`
  // explicitly; `high` is silent (it's the agent default and would clutter
  // every finding). Default to 'high' so absence-of-tag round-trips to that
  // default. The other two values come from explicit segment matches below.
  // See PR #10 dogfood comments 3295026560 (default to high) and
  // 3295156534 (don't silently round medium up).
  let confidence: Confidence = 'high';
  let title = '';
  if (headingMatch) {
    const tagInner = headingMatch[1]!;
    title = (headingMatch[2] ?? '').trim();
    const segments = tagInner.split('·').map((s) => s.trim());
    const sevToken = segments[0]?.toLowerCase();
    if (sevToken && VALID_SEVERITIES.has(sevToken as Severity)) {
      severity = sevToken as Severity;
    }
    const catToken = segments[1]?.toLowerCase();
    if (catToken && VALID_CATEGORIES.has(catToken as Category)) {
      category = catToken as Category;
    }
    for (const seg of segments.slice(2)) {
      if (/low\s+confidence/i.test(seg)) confidence = 'low';
      else if (/medium\s+confidence/i.test(seg)) confidence = 'medium';
    }
  }
  // Body after the heading line. The first non-empty paragraph is why_it_matters.
  let why_it_matters = '';
  if (headingMatch) {
    const afterHeading = body.slice(headingMatch.index! + headingMatch[0].length);
    // Strip optional ```suggestion / provenance trailer for the "why" capture.
    const stripped = afterHeading
      .replace(/\n\n```suggestion[\s\S]*?```/g, '')
      .replace(/\n\n_via [^_]+_\s*$/g, '');
    const paragraphs = stripped
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    why_it_matters = paragraphs[0] ?? '';
  }
  return { severity, category, confidence, title, why_it_matters };
}

// exported for tests
export function serializeConfigAsYaml(cfg: ReviewConfig): string {
  // yaml.stringify covers every ReviewConfig field automatically. Hand-rolling
  // this used to silently drop new fields (prompt, focus, context, review.*,
  // security.cache, security.persistence) when the schema grew. See PR #10
  // comments 3294958549 and 3294969031.
  return stringifyYaml(cfg as unknown as Record<string, unknown>);
}
