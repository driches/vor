import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlants } from '../plant/plant-runner.js';
import { loadCase } from './case-loader.js';
import { evalRun } from './orchestrator-adapter.js';
import { scoreRun } from './scoring.js';
import { renderSummaryReport } from './report.js';
import { loadPipelineConfig } from './config-loader.js';

describe('eval harness end-to-end', () => {
  let goldenRepo: string;
  let cleanup: string;

  beforeAll(async () => {
    cleanup = mkdtempSync(join(tmpdir(), 'eval-e2e-'));
    goldenRepo = cleanup;
    cpSync(
      join(process.cwd(), 'tests/fixtures/golden-repo/cases'),
      join(goldenRepo, 'cases'),
      { recursive: true },
    );
    await runPlants(join(goldenRepo, 'cases/demo'));
  });

  afterAll(() => {
    rmSync(cleanup, { recursive: true });
  });

  it('plants the case, runs orchestrator, scores, and renders a report', async () => {
    const c = loadCase(goldenRepo, 'demo');
    expect(c.truths).toHaveLength(2);
    expect(c.truths[0]!.bug_type).toBe('secret:aws-access-key');
    expect(c.truths[1]!.bug_type).toContain('vuln-dep:npm');

    const cfg = loadPipelineConfig(join(process.cwd(), 'configs/pipeline/haiku-only.yml'));

    const run = await evalRun({
      case: c,
      config: cfg,
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
                assessment_reasoning: 'AI did not post inline comments in this test',
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

    // The scanner runner is the production code path. With the planted AWS
    // key, the secrets scanner should produce a finding. The lockfile CVE
    // requires an OSV call which isn't stubbed here — tolerate 0 or 1
    // findings for that and assert at least the secrets one.
    expect(run.findings.length).toBeGreaterThanOrEqual(1);
    expect(run.findings.some((f) => f.file_path === 'src/auth.ts')).toBe(true);

    const score = scoreRun({
      case_id: c.case_id,
      config_name: 'haiku-only',
      truths: c.truths,
      findings: run.findings,
      cost: run.cost,
    });
    expect(score.tp).toBeGreaterThanOrEqual(1);

    const md = renderSummaryReport({
      timestamp: '2026-05-23T00:00:00Z',
      baseline_config: 'haiku-only',
      scores: [score],
    });
    expect(md).toContain('# Eval run');
    expect(md).toContain('demo');
    expect(md).toContain('haiku-only');
  });
});
