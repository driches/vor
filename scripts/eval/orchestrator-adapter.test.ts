import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted state controlling the orchestrator mock below. The mock passes
// through to the real `runOrchestrator` by default — every test in this file
// keeps exercising the production path. Setting `nextRejection` makes the
// next call throw instead, isolating the "evalRun re-throws" contract test
// from the full async agent+scanner plumbing that intermittently wedges
// vitest workers in CI. See https://github.com/driches/vor/issues/30.
const orchestratorState = vi.hoisted(() => ({
  nextRejection: null as Error | null,
}));

vi.mock('../../src/orchestrator.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/orchestrator.js')>();
  return {
    ...actual,
    runOrchestrator: vi.fn(
      async (input: Parameters<typeof actual.runOrchestrator>[0]) => {
        if (orchestratorState.nextRejection !== null) {
          const err = orchestratorState.nextRejection;
          orchestratorState.nextRejection = null;
          throw err;
        }
        return actual.runOrchestrator(input);
      },
    ),
  };
});

import {
  evalRun,
  FakeProvider,
  reconstructFinding,
  serializeConfigAsYaml,
  synthesizeDiff,
} from './orchestrator-adapter.js';
import type { LoadedCase } from './case-loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/types.js';
import type { CompleteResponse } from '../../src/llm/types.js';

afterEach(() => {
  // Defense-in-depth: a test that sets `nextRejection` but never triggers
  // the consuming evalRun would otherwise leak its rejection into the next
  // test. The single test that uses this clears it on consumption, but
  // pinning the invariant here keeps future authors from getting bitten.
  orchestratorState.nextRejection = null;
});

const fakeCase: LoadedCase = {
  case_id: 'unit',
  files: [
    { path: 'src/auth.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
  ],
  // Empty before/ so the planted AWS key appears as an added line in the
  // synthesized diff (matches a "fresh plant" scenario in golden cases).
  beforeFiles: [{ path: 'src/auth.ts', content: '\n' }],
  truths: [
    {
      file: 'src/auth.ts',
      line_range: [1, 1],
      bug_type: 'secret:aws-access-key',
      severity: 'critical',
      plant_id: 0,
      category: ['vulnerability', 'security'],
    },
  ],
};

/**
 * Canonical responses the FakeProvider emits in a typical eval scenario:
 *   - Turn 1: model calls post_summary so the runner exits via `summary_posted`.
 *   - Turn 2: scripted but rarely reached — the runner stops after the summary
 *     post; we include it to be defensive against future runner refactors
 *     that keep iterating after a summary.
 * Every turn carries identical 100/50 token usage so the cost tests below
 * have a stable per-turn budget to multiply against per-model pricing.
 */
function summaryScript(): CompleteResponse[] {
  return [
    {
      text: '',
      tool_calls: [
        {
          id: 't1',
          name: 'post_summary',
          arguments: {
            strengths: ['Clear separation of concerns in the auth module.'],
            assessment: 'comment',
            assessment_reasoning: 'No AI findings in this unit-test scenario; observations only.',
          },
        },
      ],
      stop_reason: 'tool_calls',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    {
      text: 'done',
      tool_calls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ];
}

/**
 * Single-turn end_turn-only script for tests that exit the loop immediately
 * (no post_summary). Useful for the pricing-comparison tests where we just
 * want one turn of token usage to flow through computeCostUsd.
 */
function endTurnScript(): CompleteResponse[] {
  return [
    {
      text: 'done',
      tool_calls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ];
}

describe('evalRun', () => {
  it('invokes the orchestrator with the case content and captures findings + cost', async () => {
    const result = await evalRun({
      case: fakeCase,
      config: DEFAULT_CONFIG,
      apiKey: 'sk-ant-test',
      agentScript: summaryScript(),
    });

    // The secrets scanner should pick up the AWS key (it's in the case content
    // and is on an added line in the synthesized diff).
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.some((f) => f.file_path === 'src/auth.ts')).toBe(true);
    expect(result.cost.turns).toBe(1);
    expect(result.cost.wall_ms).toBeGreaterThan(0);
    expect(result.cost.ended_reason).toBe('summary_posted');
    // Cost record now carries provider id; DEFAULT_CONFIG uses an Anthropic
    // model so the resolved provider must be 'anthropic'.
    expect(result.cost.provider).toBe('anthropic');
  });

  it('preserves the scanner-emitted category and severity (no hardcoded security/minor)', async () => {
    // Regression for PR #10 comments 3294902772 + 3294915010. Previously every
    // finding came back as `{ severity: 'minor', category: 'security' }` no
    // matter what the orchestrator actually produced — which meant any truth
    // with `category: ['vulnerability']` (e.g. secrets, CVEs) always scored
    // as FN.
    const result = await evalRun({
      case: fakeCase,
      config: DEFAULT_CONFIG,
      apiKey: 'sk-ant-test',
      agentScript: summaryScript(),
    });

    // The secrets scanner emits the AWS-key finding as
    // { severity: 'critical', category: 'vulnerability' }. The eval-adapter
    // must round-trip both faithfully.
    const awsFinding = result.findings.find((f) => f.file_path === 'src/auth.ts');
    expect(awsFinding).toBeDefined();
    expect(awsFinding!.category).toBe('vulnerability');
    expect(awsFinding!.severity).toBe('critical');
    expect(awsFinding!.title.length).toBeGreaterThan(0);
    // Regression for dogfood comment 3295026560. Scanner findings post at
    // confidence: 'high', and renderCommentBody is silent for high/medium
    // (only 'low' gets a heading tag). The adapter's default must therefore
    // be 'high', not 'medium', or every scanner finding round-trips as a
    // downgraded medium-confidence comment.
    expect(awsFinding!.confidence).toBe('high');
  });

  it('computes cost_usd per-model (sonnet > haiku for identical token usage)', async () => {
    // Regression for the dogfood finding that `state.costAccum.turns * 0.01`
    // made every model produce the same cost, defeating the cost-comparison
    // axis of the eval harness. Per-model pricing must differentiate sonnet
    // vs. haiku for identical token usage.
    const minimalCase: LoadedCase = {
      case_id: 'pricing',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    const sonnetResult = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-sonnet-4-6' },
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });
    const haikuResult = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-haiku-4-5' },
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });
    expect(sonnetResult.cost.cost_usd).toBeGreaterThan(haikuResult.cost.cost_usd);
  });

  it('propagates orchestrator exceptions instead of swallowing them into ended_reason', async () => {
    // Regression for PR #10 Codex P1 3295104167. The previous code wrapped
    // runOrchestrator in try/catch and converted any throw into
    // `ended_reason: 'error: ...'` with an empty `findings` array — which
    // then flowed into scoring as a 0% recall result, making transient
    // API/infra failures look like real model regressions in the report.
    //
    // The contract under test is purely evalRun's behavior: when
    // runOrchestrator throws, evalRun MUST re-throw rather than convert
    // the error into a synthetic `ended_reason: 'error: ...'`. We mock the
    // orchestrator boundary (see top of file) to induce that throw
    // directly. An earlier version of this test induced the rejection via
    // an empty agentScript so the FakeProvider would throw deep inside the
    // orchestrator's runAgent → Promise.allSettled → re-throw plumbing —
    // that path intermittently wedged vitest workers in CI (see issue
    // #30). Mocking at the function boundary tests the same property
    // (no try/catch swallowing) without exercising the suspect async path.
    const minimalCase: LoadedCase = {
      case_id: 'propagation',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    orchestratorState.nextRejection = new Error(
      'agentScript exhausted — test did not script enough turns',
    );
    await expect(
      evalRun({
        case: minimalCase,
        config: {
          ...DEFAULT_CONFIG,
          security: { ...DEFAULT_CONFIG.security, enabled: false },
        },
        apiKey: 'sk-ant-test',
        agentScript: [],
      }),
    ).rejects.toThrow(/agentScript exhausted/);
  });

  it('throws when an unknown model id is used (no silent synthetic-cost fallback)', async () => {
    // Regression for PR #10 Codex P2 3295074807. The eval harness's whole
    // purpose is to compare costs across configs; a typo or new model id
    // that silently fell back to `turns * 0.01` would produce report cells
    // that LOOK valid but mis-rank configs on the cost axis. Fail loud.
    const minimalCase: LoadedCase = {
      case_id: 'unknown-model',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    // Note: evalRun rejects (the throw inside the orchestrator path bubbles
    // up). The error mentions the offending model id and lists known models.
    await expect(
      evalRun({
        case: minimalCase,
        config: { ...DEFAULT_CONFIG, model: 'claude-sonet-4-6' as unknown as string }, // typo
        apiKey: 'sk-ant-test',
        agentScript: endTurnScript(),
      }),
    ).rejects.toThrow(/no pricing entry.*claude-sonet-4-6/);
  });

  it('prices both claude-opus-4-7 and claude-opus-4-1 at real Opus rates (not the fallback)', async () => {
    // Regression for PR #10 Codex P1 3294995644. The opus-only.yml pipeline
    // config uses claude-opus-4-7; if MODEL_PRICING is missing that key,
    // costs would fall through to the synthetic `turns * 0.01` fallback and
    // every Opus run would report a flat fake cost.
    //
    // PR #13 update: Opus 4.7 was repriced to the new lower Opus tier
    // ($5/$25), distinct from Opus 4.1's legacy higher tier ($15/$75). The
    // test now asserts each at its respective real rate AND verifies the
    // expected 4.7 < 4.1 ordering — both signals that distinguish real
    // pricing from the synthetic fallback.
    const minimalCase: LoadedCase = {
      case_id: 'opus-pricing',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    const opus47 = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-opus-4-7' },
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });
    const opus41 = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-opus-4-1' },
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });
    // Real Opus pricing on the script's hardcoded 100 in + 50 out tokens:
    //   4.7 (new tier):  100 *  5 / 1e6 + 50 * 25 / 1e6 = $0.00175
    //   4.1 (legacy):    100 * 15 / 1e6 + 50 * 75 / 1e6 = $0.00525
    // The synthetic fallback would be `turns * 0.01` = $0.01. Both real
    // prices sit well below that.
    expect(opus47.cost.cost_usd).toBeCloseTo(0.00175, 6);
    expect(opus41.cost.cost_usd).toBeCloseTo(0.00525, 6);
    expect(opus47.cost.cost_usd).toBeLessThan(opus41.cost.cost_usd);
    expect(opus41.cost.cost_usd).toBeLessThan(0.01);
  });

  it('routes OpenAI models through the providerFactory and stamps provider=openai on cost', async () => {
    // Task 6 regression: the harness is now provider-agnostic. When the
    // configured model resolves to OpenAI, the adapter must pick that
    // provider id (no Anthropic SDK touched) and stamp the same id on the
    // cost record so report rendering can differentiate vendors.
    const minimalCase: LoadedCase = {
      case_id: 'openai-routing',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    const result = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'gpt-4.1' },
      apiKey: 'sk-openai-test',
      agentScript: endTurnScript(),
    });
    expect(result.cost.provider).toBe('openai');
    // Cost must use OpenAI pricing, not the Anthropic Sonnet fallback.
    // GPT-4.1 input is $2/M and output is $8/M → 100 * 2 / 1e6 + 50 * 8 / 1e6 = $0.0006.
    expect(result.cost.cost_usd).toBeCloseTo(0.0006, 6);
  });

  it('force-disables worker_delegation in the sandboxed config so eval runs never hit real Anthropic SDK (Codex P2 #3300812876)', async () => {
    // Case configs that opt into `experimental.worker_delegation.enabled`
    // would otherwise cause runAgent to construct a real
    // `new Anthropic({ apiKey })` for pre-flight Haiku + WorkerClient —
    // bypassing the providerFactory sandbox and either hitting the live
    // API or 401'ing with the dummy test key. evalRun deep-clones the
    // input and force-disables the flag before serializing to YAML.
    //
    // The caller's config object must NOT be mutated (clones are dropped).
    const callerConfig: ReviewConfig = {
      ...DEFAULT_CONFIG,
      experimental: {
        ...DEFAULT_CONFIG.experimental,
        worker_delegation: {
          ...DEFAULT_CONFIG.experimental.worker_delegation,
          enabled: true,
        },
      },
    };
    const minimalCase: LoadedCase = {
      case_id: 'sandbox-worker-disable',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    await evalRun({
      case: minimalCase,
      config: callerConfig,
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });

    // 1. The caller's config is unmutated — they still see enabled: true.
    expect(callerConfig.experimental.worker_delegation.enabled).toBe(true);
    // 2. The serialized .vor.yml the orchestrator reads has the
    //    flag flipped off (we don't have direct access to it post-run, but
    //    the absence of a thrown error from runAgent's worker/pre-flight
    //    code paths is the load-bearing signal — with enabled=true and
    //    the dummy key, the real Anthropic SDK would have 401'd).
    // 3. Implicit by surviving the await above without an Anthropic SDK
    //    auth error.
  });

  it('does not double-charge cached tokens for cache-heavy OpenAI scripts (Codex P2 #3300723609)', async () => {
    // OpenAI reports `input_tokens` INCLUDING cached_tokens as a subset
    // (charged at the discounted cache_read rate). Without provider-aware
    // normalization in the cost accumulator, computeCostUsd would bill
    // both `input_tokens * input_rate` and `cache_read * cache_read_rate`
    // — counting the cached portion twice. This test pins the fix that
    // applies `inputTokensFullRate(usage)` when stashing into costAccum.
    const minimalCase: LoadedCase = {
      case_id: 'openai-cache-heavy',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    const cacheHeavyScript: CompleteResponse[] = [
      {
        text: 'done',
        tool_calls: [],
        stop_reason: 'end_turn',
        // OpenAI shape: input_tokens (1000) includes cache_read_tokens (600)
        // as a subset. Full-rate portion is 400. Expected gpt-4.1 cost:
        //   400 * $2/M + 50 * $8/M + 600 * $0.5/M = $0.0008 + $0.0004 + $0.0003 = $0.0015.
        // Without the fix, the harness would compute 1000 * $2/M (full-rate
        // on the full 1000, INCLUDING the cached portion) + 50 * $8/M +
        // 600 * $0.5/M = $0.0027 — almost 2× higher, mis-ranking configs.
        usage: { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 600 },
      },
    ];
    const result = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'gpt-4.1' },
      apiKey: 'sk-openai-test',
      agentScript: cacheHeavyScript,
    });
    expect(result.cost.cost_usd).toBeCloseTo(0.0015, 6);
    // Persisted record stores the full-rate input portion (matches the
    // runner's perModelCost semantics — input_tokens means "full-rate input").
    expect(result.cost.input_tokens).toBe(400);
    expect(result.cost.cache_read_input_tokens).toBe(600);
  });

  it('FakeProvider.inputTokensFullRate dispatches per provider id', () => {
    // Today's eval scripts use zero cache tokens so the Anthropic and OpenAI
    // formulas happen to converge — but the runner's budget gate must see
    // the same shape production would. Pin the divergence on a non-zero
    // cache payload so a future "simplify" refactor that collapses the two
    // branches fails here.
    const anth = new FakeProvider('anthropic', []);
    const oai = new FakeProvider('openai', []);
    const usage = {
      input_tokens: 1000,
      output_tokens: 50,
      cache_creation_tokens: 200,
      cache_read_tokens: 600,
    };
    // Anthropic: returns input_tokens unchanged (cache_creation rides on
    // the Budget accumulator's separate field; cache_read is excluded).
    expect(anth.inputTokensFullRate(usage)).toBe(1000);
    // OpenAI: input - cache_read = 400.
    expect(oai.inputTokensFullRate(usage)).toBe(400);
  });

  it('throws when invoked concurrently (module-scope state would corrupt)', async () => {
    // Regression for the dogfood finding that module-scope `state` would
    // corrupt if two evalRun calls overlap. Phase B intends to Promise.all
    // across configs, so we fail fast.
    const minimalCase: LoadedCase = {
      case_id: 'concurrency',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    const first = evalRun({
      case: minimalCase,
      config: DEFAULT_CONFIG,
      apiKey: 'sk-ant-test',
      agentScript: endTurnScript(),
    });
    await expect(
      evalRun({
        case: minimalCase,
        config: DEFAULT_CONFIG,
        apiKey: 'sk-ant-test',
        agentScript: endTurnScript(),
      }),
    ).rejects.toThrow(/concurrent invocations/);
    await first; // drain the first one
  });

  it('does NOT flag pre-existing content (before/ === after/)', async () => {
    // Regression for PR #10 comment 3294950624. Previously the synthesized
    // diff marked every file as `new file mode` with all content on `+`
    // lines, so scanners saw pre-existing issues in before/ as added — biasing
    // precision. With a real unified diff, an unchanged file produces no
    // patch entry and no findings.
    const unchangedCase: LoadedCase = {
      case_id: 'unit-unchanged',
      files: [
        { path: 'src/foo.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
      ],
      beforeFiles: [
        { path: 'src/foo.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
      ],
      truths: [],
    };
    const result = await evalRun({
      case: unchangedCase,
      config: DEFAULT_CONFIG,
      apiKey: 'sk-ant-test',
      agentScript: summaryScript(),
    });
    // The AWS key was already in before/. No diff entry → no findings.
    expect(result.findings.filter((f) => f.file_path === 'src/foo.ts')).toHaveLength(0);
  });
});

describe('reconstructFinding', () => {
  it('preserves start_line for multi-line review comments', () => {
    // Regression for PR #10 Codex P2 3295082015. scoreRun matches findings
    // by the range [start_line ?? line, line]. If the adapter drops
    // start_line during reconstruction, every multi-line comment collapses
    // back to a single-line anchor at `line` and the range-overlap logic
    // (added in Fix N) is defeated.
    const finding = reconstructFinding({
      path: 'src/auth.ts',
      line: 25,
      start_line: 10,
      side: 'RIGHT',
      body: '**[CRITICAL · vulnerability]** AWS key in source\n\nLeaked credential.',
    });
    expect(finding.line).toBe(25);
    expect(finding.start_line).toBe(10);
    expect(finding.file_path).toBe('src/auth.ts');
    expect(finding.category).toBe('vulnerability');
    expect(finding.severity).toBe('critical');
  });

  it('preserves medium confidence (regression: round-up to high)', () => {
    // Regression for PR #10 dogfood MINOR 3295156534. renderCommentBody now
    // tags both `low confidence` and `medium confidence` explicitly so the
    // adapter can round-trip the original value. Before this fix, medium
    // was silent in the heading (same as high) and parseRenderedComment
    // defaulted to high — every medium-confidence scanner finding (AWS
    // secret, JWT) silently rounded up to high in RunRecord.findings.
    const finding = reconstructFinding({
      path: 'src/auth.ts',
      line: 5,
      side: 'RIGHT',
      body: '**[IMPORTANT · vulnerability · medium confidence]** Maybe leaked\n\nThe match could be a base64 string with high entropy that happens to match the AWS secret pattern.',
    });
    expect(finding.confidence).toBe('medium');
  });

  it('preserves low confidence (regression: explicit tag wins)', () => {
    const finding = reconstructFinding({
      path: 'src/foo.ts',
      line: 1,
      side: 'RIGHT',
      body: '**[MINOR · readability · low confidence]** Style thought\n\nNot a strong opinion.',
    });
    expect(finding.confidence).toBe('low');
  });

  it('omits start_line for single-line comments (no spurious field)', () => {
    // start_line is optional on PostedComment; reconstructFinding must NOT
    // add it as an explicit undefined or 0 when the source payload has no
    // start_line. Both downstream consumers (scoreRun and any JSON
    // serializer for RunRecord) rely on its absence to mean "single-line".
    const finding = reconstructFinding({
      path: 'src/auth.ts',
      line: 5,
      side: 'RIGHT',
      body: '**[MINOR · readability]** Title\n\nBody text here.',
    });
    expect(finding.line).toBe(5);
    expect('start_line' in finding).toBe(false);
  });
});

describe('synthesizeDiff', () => {
  it('emits file chunks in lexicographic order even when after/ adds new files', () => {
    // Regression for PR #10 comment 3295052526. Before this fix, `allPaths`
    // came from a Set that preserved before-keys-first insertion order, so a
    // case with before/{zzz.ts} and after/{zzz.ts, aaa-new.ts} emitted the
    // new file AFTER the existing one. Sorting the merged Set makes the
    // synthesized diff fully lexicographic across before-only, modified,
    // and after-only paths.
    const c: LoadedCase = {
      case_id: 'sort-test',
      beforeFiles: [
        { path: 'src/zzz.ts', content: '// existing\n' },
      ],
      files: [
        // Intentionally non-alphabetical order: 'zzz' (modified) listed first
        // in the case, then 'aaa-new' (new-only) — exercises the
        // before-keys-then-after-only-keys merge in synthesizeDiff.
        { path: 'src/zzz.ts', content: '// existing, edited\n' },
        { path: 'src/aaa-new.ts', content: '// new file\n' },
      ],
      truths: [],
    };
    const { filesApi } = synthesizeDiff(c);
    expect(filesApi.map((f) => f.filename)).toEqual([
      'src/aaa-new.ts',
      'src/zzz.ts',
    ]);
  });

  it('emits a valid unified-diff body for modified files', () => {
    // Regression for PR #10 dogfood MINOR 3295239968. The file-order test
    // above only checks `filesApi[].filename`. A broken `--- a/`/`+++ b/`
    // prefix substitution or off-by-one in renderModifiedFile's `idx + 2`
    // skip would pass silently while breaking the orchestrator's downstream
    // diff parser. Assert the actual diff body has the expected headers
    // and hunk shape.
    const c: LoadedCase = {
      case_id: 'diff-body',
      beforeFiles: [{ path: 'src/auth.ts', content: 'line1\nline2\nline3\n' }],
      files: [{ path: 'src/auth.ts', content: 'line1\nline2-edited\nline3\n' }],
      truths: [],
    };
    const { diff, filesApi } = synthesizeDiff(c);
    expect(filesApi).toHaveLength(1);
    // Required diff structure for the orchestrator's parse-diff consumer:
    expect(diff).toContain('diff --git a/src/auth.ts b/src/auth.ts');
    expect(diff).toContain('--- a/src/auth.ts');
    expect(diff).toContain('+++ b/src/auth.ts');
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    // The modified line shows up as a remove + add pair.
    expect(diff).toContain('-line2');
    expect(diff).toContain('+line2-edited');
    // Context lines (`line1` and `line3`) are present without `+`/`-` markers.
    expect(diff).toMatch(/^ line1$/m);
    expect(diff).toMatch(/^ line3$/m);
  });

  it('emits a valid unified-diff body for new files', () => {
    // Companion coverage for renderNewFile, which uses a different
    // code path (the synthetic `diff --git`, `new file mode`,
    // `--- /dev/null`, `+++ b/...` shape, all `+` lines).
    const c: LoadedCase = {
      case_id: 'new-file',
      beforeFiles: [],
      files: [{ path: 'src/brand-new.ts', content: 'export const x = 1;\n' }],
      truths: [],
    };
    const { diff, filesApi } = synthesizeDiff(c);
    expect(filesApi).toHaveLength(1);
    expect(filesApi[0]!.filename).toBe('src/brand-new.ts');
    expect(diff).toContain('diff --git a/src/brand-new.ts b/src/brand-new.ts');
    expect(diff).toContain('new file mode 100644');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/src/brand-new.ts');
    expect(diff).toContain('@@ -0,0 +1,1 @@');
    expect(diff).toContain('+export const x = 1;');
  });
});

describe('serializeConfigAsYaml', () => {
  it('preserves non-default fields like prompt.additions (regression: hand-rolled drop)', () => {
    // The previous hand-rolled YAML serializer silently dropped fields outside
    // its short whitelist (prompt, focus, context, review.*, security.cache,
    // security.persistence). Switching to yaml.stringify covers every field
    // automatically.
    const cfg: ReviewConfig = {
      ...DEFAULT_CONFIG,
      prompt: { ...DEFAULT_CONFIG.prompt, additions: 'TEST-PERSONA' },
    };
    const yaml = serializeConfigAsYaml(cfg);
    expect(yaml).toContain('TEST-PERSONA');
  });
});
