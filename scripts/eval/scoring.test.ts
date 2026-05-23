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
});
