import { describe, expect, it } from 'vitest';
import {
  evalRun,
  reconstructFinding,
  serializeConfigAsYaml,
  synthesizeDiff,
} from './orchestrator-adapter.js';
import type { LoadedCase } from './case-loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/types.js';

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

describe('evalRun', () => {
  it('invokes the orchestrator with the case content and captures findings + cost', async () => {
    const result = await evalRun({
      case: fakeCase,
      config: DEFAULT_CONFIG,
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'post_summary',
              input: {
                strengths: [],
                assessment: 'comment',
                assessment_reasoning: 'No AI findings in unit test',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
      ],
    });

    // The secrets scanner should pick up the AWS key (it's in the case content
    // and is on an added line in the synthesized diff).
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.some((f) => f.file_path === 'src/auth.ts')).toBe(true);
    expect(result.cost.turns).toBe(1);
    expect(result.cost.wall_ms).toBeGreaterThan(0);
    expect(result.cost.ended_reason).toBe('summary_posted');
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
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'post_summary',
              input: {
                strengths: [],
                assessment: 'comment',
                assessment_reasoning: 'No AI findings in unit test',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'end' }],
          stop_reason: 'end_turn',
        },
      ],
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
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      ],
    });
    const haikuResult = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-haiku-4-5' },
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      ],
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
    // We force a throw by handing the agent script an EMPTY array: the
    // mocked SDK throws `agentScript exhausted` on the first turn,
    // simulating an unexpected runtime failure deep in the orchestrator.
    const minimalCase: LoadedCase = {
      case_id: 'propagation',
      files: [{ path: 'src/empty.ts', content: '// empty\n' }],
      beforeFiles: [{ path: 'src/empty.ts', content: '\n' }],
      truths: [],
    };
    await expect(
      evalRun({
        case: minimalCase,
        config: DEFAULT_CONFIG,
        anthropicApiKey: 'sk-ant-test',
        agentScript: [], // empty → SDK mock will throw on the first turn
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
        anthropicApiKey: 'sk-ant-test',
        agentScript: [
          { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
        ],
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
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      ],
    });
    const opus41 = await evalRun({
      case: minimalCase,
      config: { ...DEFAULT_CONFIG, model: 'claude-opus-4-1' },
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      ],
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
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      ],
    });
    await expect(
      evalRun({
        case: minimalCase,
        config: DEFAULT_CONFIG,
        anthropicApiKey: 'sk-ant-test',
        agentScript: [
          { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
        ],
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
      anthropicApiKey: 'sk-ant-test',
      agentScript: [
        {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'post_summary',
              input: {
                strengths: [],
                assessment: 'comment',
                assessment_reasoning: 'No changes',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        {
          content: [{ type: 'text', text: 'end' }],
          stop_reason: 'end_turn',
        },
      ],
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
