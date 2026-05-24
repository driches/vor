import { describe, expect, it } from 'vitest';
import { evalRun } from './orchestrator-adapter.js';
import type { LoadedCase } from './case-loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

const fakeCase: LoadedCase = {
  case_id: 'unit',
  files: [
    { path: 'src/auth.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
  ],
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
  });
});
