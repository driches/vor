import { describe, expect, it } from 'vitest';
import { evalRun, serializeConfigAsYaml, synthesizeDiff } from './orchestrator-adapter.js';
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

  it('prices both claude-opus-4-7 and claude-opus-4-1 at Opus-tier (not the fallback)', async () => {
    // Regression for PR #10 Codex P1 3294995644. The opus-only.yml pipeline
    // config uses claude-opus-4-7; if MODEL_PRICING is missing that key,
    // costs fall through to the synthetic `turns * 0.01` fallback and
    // every Opus run reports a flat fake cost.
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
    // The fallback is exactly `turns * 0.01` = $0.01 for a 1-turn script.
    // Real Opus pricing on 100 in + 50 out tokens is:
    //   100 * 15 / 1e6 + 50 * 75 / 1e6 = 0.0015 + 0.00375 = $0.00525
    // — well under $0.01. Asserting <$0.01 distinguishes Opus pricing from
    // the fallback.
    expect(opus47.cost.cost_usd).toBeLessThan(0.01);
    expect(opus47.cost.cost_usd).toBe(opus41.cost.cost_usd);
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
