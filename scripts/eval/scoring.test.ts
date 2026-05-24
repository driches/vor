import { describe, expect, it } from 'vitest';
import { scoreRun } from './scoring.js';
import type { RunRecord, TruthEntry } from './types.js';
import type { PostedComment } from '../../src/types.js';

function finding(over: Partial<PostedComment> = {}): PostedComment {
  return {
    severity: 'critical',
    file_path: 'src/auth.ts',
    line: 1,
    side: 'RIGHT',
    category: 'vulnerability',
    title: 'AWS key',
    why_it_matters: '',
    confidence: 'high',
    ...over,
  };
}

function truth(over: Partial<TruthEntry> = {}): TruthEntry {
  return {
    file: 'src/auth.ts',
    line_range: [1, 1],
    bug_type: 'secret:aws-access-key',
    severity: 'critical',
    plant_id: 0,
    category: ['vulnerability', 'security'],
    ...over,
  };
}

const cost: RunRecord['cost'] = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cost_usd: 0.5,
  turns: 1,
  wall_ms: 100,
  ended_reason: 'summary_posted',
};

describe('scoreRun', () => {
  it('matches exact (file, line, compatible category) → TP', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth()],
      findings: [finding()],
      cost,
    });
    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
    expect(result.fp).toBe(0);
    expect(result.recall).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.unaligned).toEqual([]);
    expect(result.cost_per_tp_usd).toBeCloseTo(0.5);
  });

  it('matches within 3-line slack on the same file + compatible category', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 10] })],
      findings: [finding({ line: 13 })],
      cost,
    });
    expect(result.tp).toBe(1);
  });

  it('misses outside the 3-line slack → FN', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 10] })],
      findings: [finding({ line: 14 })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
    expect(result.unaligned).toHaveLength(1);
  });

  it('mismatched category → FN + FP', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ category: ['vulnerability'] })],
      findings: [finding({ category: 'readability' })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
  });

  it('different file → FN', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ file: 'src/a.ts' })],
      findings: [finding({ file_path: 'src/b.ts' })],
      cost,
    });
    expect(result.tp).toBe(0);
    expect(result.fn).toBe(1);
    expect(result.fp).toBe(1);
  });

  it('cost_per_tp_usd uses max(TP, 1) so zero-TP runs report finite cost', () => {
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth()],
      findings: [],
      cost: { ...cost, cost_usd: 1.0 },
    });
    expect(result.tp).toBe(0);
    expect(result.cost_per_tp_usd).toBe(1.0);
  });

  it('preserves all outcomes for the report renderer', () => {
    const t1 = truth({ plant_id: 0 });
    const t2 = truth({ plant_id: 1, file: 'src/other.ts', line_range: [5, 5] });
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [t1, t2],
      findings: [finding()],
      cost,
    });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.status).toBe('matched');
    expect(result.outcomes[1]!.status).toBe('missed');
  });

  it('matches a finding inside a multi-line truth range (regression: range-end-anchor)', () => {
    // Truth spans lines 10..20; a finding at line 15 must match. The previous
    // code anchored only to range[0] and failed |15 - 10| <= 3.
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 20] })],
      findings: [finding({ line: 15 })],
      cost,
    });
    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
    expect(result.fp).toBe(0);
  });

  it('applies the line slack at both ends of a multi-line range', () => {
    // At rangeEnd + LINE_SLACK (20 + 3 = 23) → still TP.
    const tpResult = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 20] })],
      findings: [finding({ line: 23 })],
      cost,
    });
    expect(tpResult.tp).toBe(1);
    expect(tpResult.fn).toBe(0);
    expect(tpResult.fp).toBe(0);

    // At rangeEnd + LINE_SLACK + 1 (20 + 4 = 24) → FN + FP.
    const fnResult = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 20] })],
      findings: [finding({ line: 24 })],
      cost,
    });
    expect(fnResult.tp).toBe(0);
    expect(fnResult.fn).toBe(1);
    expect(fnResult.fp).toBe(1);
  });

  it('matches a multi-line finding when its range covers the truth line (regression: end-line-only bias)', () => {
    // Regression for PR #10 Codex P2 3295074806. PostedComment carries
    // `start_line` for multi-line comments. The previous scorer only
    // checked `finding.line` (= end line) against the truth slack window,
    // so a multi-line finding [10, 25] against a truth at line 12 would
    // fail |25 - 12| <= 3 and score as FN + FP — even though the finding
    // explicitly covered the planted line.
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [12, 12] })],
      findings: [finding({ start_line: 10, line: 25, category: 'vulnerability' })],
      cost,
    });
    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
    expect(result.fp).toBe(0);
  });

  it('matches a single-line finding (no start_line) by the existing point-vs-range logic', () => {
    // Sanity check that the range-overlap change didn't regress
    // single-line findings (start_line absent → range collapses to just
    // `line`). Truth at [10, 20], single-line finding at 15 → still TP.
    const result = scoreRun({
      case_id: 'c',
      config_name: 'cfg',
      truths: [truth({ line_range: [10, 20] })],
      findings: [finding({ line: 15, category: 'vulnerability' })],
      cost,
    });
    expect(result.tp).toBe(1);
    expect(result.fn).toBe(0);
  });

  it('finds optimal matching when truth compat sets overlap (regression: greedy bias)', () => {
    // Truth A is permissive: matches both 'security' and 'vulnerability'.
    // Truth B is restrictive: matches only 'security'.
    // Finding F1 is 'security'; F2 is 'vulnerability'.
    // Greedy in input order (A, B) would pair A→F1, leaving B with no
    // compatible finding (F2 is 'vulnerability', not in B's category list).
    // Optimal pairs A→F2, B→F1, achieving 2 TPs.
    const truthA = truth({
      plant_id: 0,
      line_range: [10, 10],
      category: ['security', 'vulnerability'],
    });
    const truthB = truth({
      plant_id: 1,
      line_range: [10, 10],
      category: ['security'],
    });
    const f1 = finding({ line: 10, category: 'security' });
    const f2 = finding({ line: 10, category: 'vulnerability' });
    const result = scoreRun({
      case_id: 'opt',
      config_name: 'cfg',
      truths: [truthA, truthB],
      findings: [f1, f2],
      cost,
    });
    expect(result.tp).toBe(2);
    expect(result.fn).toBe(0);
    expect(result.fp).toBe(0);
  });
});
