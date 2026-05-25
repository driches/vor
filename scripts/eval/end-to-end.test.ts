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

// Default agent script: the agent posts no inline comments and emits a
// `post_summary` tool use, then ends its turn. Findings under this script
// come entirely from the production scanner path (secrets / dependency-cve),
// which is exactly what we want when the goal is "does the harness wire up
// end-to-end without mocking the agent's inferences?".
// Canonical-shape script (Task 6 of OpenAI provider work migrated the
// adapter off the Anthropic-SDK-shaped `AgentTurnResponse` to the
// provider-agnostic `CompleteResponse`).
const SILENT_AGENT_SCRIPT = [
  {
    text: '',
    tool_calls: [
      {
        id: 't1',
        name: 'post_summary',
        arguments: {
          strengths: [],
          assessment: 'comment',
          assessment_reasoning: 'AI did not post inline comments in this test',
        },
      },
    ],
    stop_reason: 'tool_calls' as const,
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  {
    text: 'done',
    tool_calls: [],
    stop_reason: 'end_turn' as const,
    usage: { input_tokens: 100, output_tokens: 50 },
  },
];

describe('eval harness end-to-end', () => {
  let goldenRepo: string;
  let cleanup: string;

  // Cases we exercise end-to-end. `demo` is the original baseline and gets
  // a deep regression assertion. The other two extend coverage to a
  // single-bug case (single-sql-injection — exercises the no-scanner-finding
  // path) and a multi-plant-same-file case (mixed-secrets — verifies the
  // secrets scanner finds at least the AWS key out of three planted secrets).
  const CASES = ['demo', 'single-sql-injection', 'mixed-secrets'];

  beforeAll(async () => {
    cleanup = mkdtempSync(join(tmpdir(), 'eval-e2e-'));
    goldenRepo = cleanup;
    cpSync(
      join(process.cwd(), 'tests/fixtures/golden-repo/cases'),
      join(goldenRepo, 'cases'),
      { recursive: true },
    );
    // Plant each case sequentially. runPlants does not support a `--all`
    // flag; sequential is fine here because cases are independent — the
    // shared goldenRepo tmpdir just hosts their separate subtrees.
    for (const caseId of CASES) {
      await runPlants(join(goldenRepo, 'cases', caseId));
    }
  });

  afterAll(() => {
    rmSync(cleanup, { recursive: true });
  });

  it('plants the demo case, runs orchestrator, scores, and renders a report', async () => {
    const c = loadCase(goldenRepo, 'demo');
    expect(c.truths).toHaveLength(2);
    expect(c.truths[0]!.bug_type).toBe('secret:aws-access-key');
    expect(c.truths[1]!.bug_type).toContain('vuln-dep:npm');

    const cfg = loadPipelineConfig(join(process.cwd(), 'configs/pipeline/haiku-only.yml'));

    const run = await evalRun({
      case: c,
      config: cfg,
      apiKey: 'sk-ant-test',
      agentScript: SILENT_AGENT_SCRIPT,
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

  it('runs single-sql-injection end-to-end (silent agent → 0 findings, FN=1)', async () => {
    // SQL injection is detected by the AI agent, not by any scanner the
    // production code wires in. With the agent scripted silent, this case
    // exercises the "valid empty-findings" path through scoring + reporting:
    // recall=0, precision=1 (no FPs), report still renders cleanly.
    const c = loadCase(goldenRepo, 'single-sql-injection');
    expect(c.truths).toHaveLength(1);
    expect(c.truths[0]!.bug_type).toBe('sql-injection');

    const cfg = loadPipelineConfig(join(process.cwd(), 'configs/pipeline/haiku-only.yml'));

    const run = await evalRun({
      case: c,
      config: cfg,
      apiKey: 'sk-ant-test',
      agentScript: SILENT_AGENT_SCRIPT,
    });

    const score = scoreRun({
      case_id: c.case_id,
      config_name: 'haiku-only',
      truths: c.truths,
      findings: run.findings,
      cost: run.cost,
    });
    expect(score.tp).toBe(0);
    expect(score.fn).toBe(1);
    expect(score.recall).toBe(0);

    const md = renderSummaryReport({
      timestamp: '2026-05-23T00:00:00Z',
      baseline_config: 'haiku-only',
      scores: [score],
    });
    expect(md).toContain('single-sql-injection');
  });

  it('runs mixed-secrets end-to-end (multi-plant same file)', async () => {
    // Three planted secrets (AWS key, GitHub PAT, PEM private key) in one
    // file. The production secrets scanner has patterns for AWS keys; we
    // assert at least one TP without locking in scanner-specific coverage
    // for GitHub-PAT / PEM detection (which may evolve).
    const c = loadCase(goldenRepo, 'mixed-secrets');
    expect(c.truths).toHaveLength(3);
    const bugTypes = c.truths.map((t) => t.bug_type).sort();
    expect(bugTypes).toEqual([
      'secret:aws-access-key',
      'secret:github-pat',
      'secret:pem-private-key',
    ]);

    const cfg = loadPipelineConfig(join(process.cwd(), 'configs/pipeline/haiku-only.yml'));

    const run = await evalRun({
      case: c,
      config: cfg,
      apiKey: 'sk-ant-test',
      agentScript: SILENT_AGENT_SCRIPT,
    });

    const score = scoreRun({
      case_id: c.case_id,
      config_name: 'haiku-only',
      truths: c.truths,
      findings: run.findings,
      cost: run.cost,
    });
    // The AWS-key plant should be picked up by the secrets scanner; we don't
    // assert specific TP/FN counts for github-pat and pem-private-key since
    // their scanner coverage may evolve. Just verify scoring produced a
    // result and rendering succeeded.
    expect(score.tp).toBeGreaterThanOrEqual(1);
    expect(score.tp + score.fn).toBe(3);

    const md = renderSummaryReport({
      timestamp: '2026-05-23T00:00:00Z',
      baseline_config: 'haiku-only',
      scores: [score],
    });
    expect(md).toContain('mixed-secrets');
  });
});
