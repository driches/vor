/**
 * Drive the existing src/orchestrator.runOrchestrator against a LoadedCase
 * instead of a real GitHub PR.
 *
 * Strategy: vi.mock the @octokit/rest and @anthropic-ai/sdk modules at module
 * scope so the orchestrator's createOctokit + runAgent get controllable stubs.
 * The case's `files[]` are served via the mocked `repos.getContent` and a
 * synthesized unified diff is served via `pulls.get(mediaType:'diff')`.
 *
 * CAUTION: this file installs vi.mock at module scope. It is TEST-ONLY —
 * importing from production code would replace those modules globally. Only
 * import from scripts/eval/*.test.ts.
 */
import { vi } from 'vitest';
import { createPatch } from 'diff';
import type { LoadedCase } from './case-loader.js';
import type { RunRecord } from './types.js';
import type { ReviewConfig } from '../../src/config/types.js';
import {
  type Severity,
  type Category,
  type Confidence,
  CATEGORIES,
} from '../../src/types.js';

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  'critical',
  'important',
  'minor',
  'nit',
]);
const VALID_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES);

// Per-million-token pricing as of 2026-05. Source: Anthropic pricing page.
// Used to compute eval-harness cost from the synthetic 100/50 in/out tokens-per-turn
// recorded by the mocked SDK. The orchestrator's own cost_usd hardcodes Sonnet pricing
// (see src/agent/runner.ts), so we can't reuse it for cross-model comparison.
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cache_creation: number; cache_read: number }
> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_creation: 3.75, cache_read: 0.3 },
  'claude-opus-4-1': { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_creation: 1.25, cache_read: 0.1 },
};

function computeCostUsd(cost: AdapterState['costAccum'], model: string): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Unknown model — fall back to flat estimate so eval doesn't crash.
    return cost.turns * 0.01;
  }
  return (
    (cost.input_tokens * pricing.input) / 1_000_000 +
    (cost.output_tokens * pricing.output) / 1_000_000 +
    (cost.cache_creation_input_tokens * pricing.cache_creation) / 1_000_000 +
    (cost.cache_read_input_tokens * pricing.cache_read) / 1_000_000
  );
}

interface AgentTurnResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use';
}

interface AdapterState {
  agentScript: AgentTurnResponse[];
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
  agentScript: [],
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

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = {
      create: vi.fn(async () => {
        state.costAccum.turns += 1;
        state.costAccum.input_tokens += 100;
        state.costAccum.output_tokens += 50;
        const next = state.agentScript.shift();
        if (!next) {
          throw new Error('agentScript exhausted — test did not script enough turns');
        }
        return {
          id: 'msg_eval',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: next.content,
          stop_reason: next.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      }),
    };
    constructor(_opts: { apiKey: string }) {
      // no-op
    }
  }
  return { default: FakeAnthropic };
});

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

// Import runOrchestrator AFTER the mocks above are registered.
import { runOrchestrator } from '../../src/orchestrator.js';

export interface EvalRunInput {
  case: LoadedCase;
  config: ReviewConfig;
  anthropicApiKey: string;
  agentScript: AgentTurnResponse[];
}

export interface EvalRunOutput {
  findings: RunRecord['findings'];
  cost: RunRecord['cost'];
}

export async function evalRun(input: EvalRunInput): Promise<EvalRunOutput> {
  // Reset shared state for this run.
  state.agentScript = [...input.agentScript];
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

  // The orchestrator's loadConfig will look for .code-review.yml at HEAD; we
  // serve a serialized form of the supplied config so the orchestrator picks
  // up exactly what the test asked for.
  state.caseFiles.set('.code-review.yml', serializeConfigAsYaml(input.config));

  const wallStart = Date.now();
  let endedReason = 'summary_posted';
  try {
    const out = await runOrchestrator({
      owner: 'eval',
      repo: 'eval',
      pull_number: 1,
      anthropic_api_key: input.anthropicApiKey,
      github_token: 'gh-test',
      config_path: '.code-review.yml',
      dry_run: false,
      workspace_dir: '/tmp/eval',
    });
    endedReason = out.ended;
  } catch (err) {
    endedReason = `error: ${(err as Error).message}`;
  }
  const wall_ms = Math.max(1, Date.now() - wallStart);

  const captured = state.createReviewCalls[0]?.args as
    | { comments?: Array<Record<string, unknown>> }
    | undefined;
  const findings: RunRecord['findings'] = (captured?.comments ?? []).map(
    (c) => {
      const body = typeof c.body === 'string' ? c.body : '';
      const parsed = parseRenderedComment(body);
      return {
        severity: parsed.severity,
        file_path: c.path as string,
        line: c.line as number,
        side: (c.side as 'RIGHT' | 'LEFT') ?? 'RIGHT',
        category: parsed.category,
        title: parsed.title,
        why_it_matters: parsed.why_it_matters,
        confidence: parsed.confidence,
      } satisfies RunRecord['findings'][number];
    },
  );

  return {
    findings,
    cost: {
      ...state.costAccum,
      cost_usd: computeCostUsd(state.costAccum, input.config.model),
      wall_ms,
      ended_reason: endedReason,
    },
  };
}

function synthesizeDiff(c: LoadedCase): {
  diff: string;
  filesApi: AdapterState['filesApi'];
} {
  // Compute a REAL unified diff between before/ and after/ snapshots. Only the
  // lines that were actually planted (or otherwise changed) appear as added.
  // Pre-existing content in before/ stays out of the diff, so the secrets and
  // CVE scanners don't see it as a "+" line and don't bias precision/recall.
  const beforeByPath = new Map(c.beforeFiles.map((f) => [f.path, f.content]));
  const afterByPath = new Map(c.files.map((f) => [f.path, f.content]));
  // `.code-review.yml` is adapter-internal (we inject it for config plumbing);
  // it must not appear in the diff or the orchestrator will try to review it.
  beforeByPath.delete('.code-review.yml');
  afterByPath.delete('.code-review.yml');

  const allPaths = new Set<string>([...beforeByPath.keys(), ...afterByPath.keys()]);
  const chunks: string[] = [];
  const filesApi: AdapterState['filesApi'] = [];
  for (const path of allPaths) {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);
    if (before === after) continue;
    if (before === undefined) {
      const fileDiff = renderNewFile(path, after ?? '');
      if (fileDiff == null) continue;
      chunks.push(fileDiff.diff);
      filesApi.push({ filename: path, changes: fileDiff.addedLines, patch: fileDiff.diff });
      continue;
    }
    if (after === undefined) {
      const fileDiff = renderDeletedFile(path, before);
      if (fileDiff == null) continue;
      chunks.push(fileDiff.diff);
      filesApi.push({ filename: path, changes: fileDiff.deletedLines, patch: fileDiff.diff });
      continue;
    }
    const fileDiff = renderModifiedFile(path, before, after);
    if (fileDiff == null) continue; // identical or empty patch — nothing to emit
    chunks.push(fileDiff.diff);
    filesApi.push({
      filename: path,
      changes: fileDiff.addedLines + fileDiff.deletedLines,
      patch: fileDiff.diff,
    });
  }
  return { diff: chunks.length > 0 ? chunks.join('\n') + '\n' : '', filesApi };
}

function splitBodyLines(content: string): string[] {
  const lines = content.split('\n');
  // A file ending with '\n' yields a trailing '' from split that should not be
  // counted as a body line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function renderNewFile(
  path: string,
  content: string,
): { diff: string; addedLines: number } | null {
  const lines = splitBodyLines(content);
  if (lines.length === 0) return null;
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('new file mode 100644');
  out.push('index 0000000..1111111');
  out.push('--- /dev/null');
  out.push(`+++ b/${path}`);
  out.push(`@@ -0,0 +1,${lines.length} @@`);
  for (const ln of lines) out.push('+' + ln);
  return { diff: out.join('\n'), addedLines: lines.length };
}

function renderDeletedFile(
  path: string,
  content: string,
): { diff: string; deletedLines: number } | null {
  const lines = splitBodyLines(content);
  if (lines.length === 0) return null;
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('deleted file mode 100644');
  out.push('index 1111111..0000000');
  out.push(`--- a/${path}`);
  out.push('+++ /dev/null');
  out.push(`@@ -1,${lines.length} +0,0 @@`);
  for (const ln of lines) out.push('-' + ln);
  return { diff: out.join('\n'), deletedLines: lines.length };
}

function renderModifiedFile(
  path: string,
  before: string,
  after: string,
): { diff: string; addedLines: number; deletedLines: number } | null {
  const patch = createPatch(path, before, after, '', '', { context: 3 });
  // `createPatch` output shape (8 leading lines):
  //   Index: <path>
  //   ===================================================================
  //   --- <path>
  //   +++ <path>
  //   @@ -..,.. +..,.. @@
  //   <hunk lines>...
  // We need:
  //   diff --git a/<path> b/<path>
  //   index 0000000..1111111 100644
  //   --- a/<path>
  //   +++ b/<path>
  //   @@ -..,.. +..,.. @@
  //   <hunk lines>...
  // Skip lines until we hit '--- '. If there are no hunks at all (identical
  // content edge case), return null.
  const patchLines = patch.split('\n');
  // Strip the trailing '' that comes from createPatch ending with '\n'.
  if (patchLines.length > 0 && patchLines[patchLines.length - 1] === '') {
    patchLines.pop();
  }
  let idx = 0;
  while (idx < patchLines.length && !patchLines[idx]!.startsWith('--- ')) idx += 1;
  if (idx >= patchLines.length) return null;
  // Verify there's at least one hunk header after `+++`.
  let hasHunk = false;
  for (let i = idx; i < patchLines.length; i++) {
    if (patchLines[i]!.startsWith('@@')) {
      hasHunk = true;
      break;
    }
  }
  if (!hasHunk) return null;

  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('index 0000000..1111111 100644');
  // Replace the '--- <path>' and '+++ <path>' lines with `a/`+`b/` prefixed
  // versions. Subsequent lines pass through untouched.
  out.push(`--- a/${path}`);
  out.push(`+++ b/${path}`);
  // idx points at '--- ', idx+1 at '+++ '. The hunks start at idx+2.
  let addedLines = 0;
  let deletedLines = 0;
  for (let i = idx + 2; i < patchLines.length; i++) {
    const ln = patchLines[i]!;
    out.push(ln);
    if (ln.startsWith('+') && !ln.startsWith('+++')) addedLines += 1;
    else if (ln.startsWith('-') && !ln.startsWith('---')) deletedLines += 1;
  }
  return { diff: out.join('\n'), addedLines, deletedLines };
}

/**
 * Recover severity / category / title / why-it-matters / confidence from the
 * rendered comment body that `src/github/review-poster.ts:renderCommentBody`
 * produces.
 *
 * Shape (from renderCommentBody):
 *   **[<SEVERITY> · <category>( · low confidence)?]** <title>
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
  let confidence: Confidence = 'medium';
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
    const paragraphs = stripped.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    why_it_matters = paragraphs[0] ?? '';
  }
  return { severity, category, confidence, title, why_it_matters };
}

function serializeConfigAsYaml(cfg: ReviewConfig): string {
  const lines: string[] = [];
  lines.push(`model: ${cfg.model}`);
  lines.push(`max_turns: ${cfg.max_turns}`);
  lines.push('severity:');
  lines.push(`  floor: ${cfg.severity.floor}`);
  lines.push(`  max_comments_per_file: ${cfg.severity.max_comments_per_file}`);
  lines.push(`  max_comments_total: ${cfg.severity.max_comments_total}`);
  lines.push('budget:');
  lines.push(`  max_input_tokens: ${cfg.budget.max_input_tokens}`);
  lines.push(`  max_output_tokens: ${cfg.budget.max_output_tokens}`);
  lines.push('security:');
  lines.push(`  enabled: ${cfg.security.enabled}`);
  lines.push('  scanners:');
  lines.push('    dependency_cve:');
  lines.push(`      enabled: ${cfg.security.scanners.dependency_cve.enabled}`);
  lines.push('    secrets:');
  lines.push(`      enabled: ${cfg.security.scanners.secrets.enabled}`);
  if (cfg.security.scanners.secrets.include_generic_entropy !== undefined) {
    lines.push(
      `      include_generic_entropy: ${cfg.security.scanners.secrets.include_generic_entropy}`,
    );
  }
  return lines.join('\n') + '\n';
}
