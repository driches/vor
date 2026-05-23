import { describe, expect, it } from 'vitest';
import { renderSummaryReport } from './report.js';
import type { ScoreResult } from './types.js';

function score(over: Partial<ScoreResult> & { config_name: string }): ScoreResult {
  return {
    case_id: 'demo',
    tp: 1,
    fn: 0,
    fp: 0,
    recall: 1,
    precision: 1,
    f1: 1,
    cost_per_tp_usd: 0.5,
    outcomes: [],
    unaligned: [],
    cost: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: 0.5,
      turns: 1,
      wall_ms: 100,
      ended_reason: 'summary_posted',
    },
    ...over,
  };
}

describe('renderSummaryReport', () => {
  it('emits a markdown table with one row per case and one column per config', () => {
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only' }),
        score({ config_name: 'haiku-only', cost: { ...score({ config_name: 'x' }).cost, cost_usd: 0.1 } }),
      ],
    });
    expect(md).toContain('# Eval run 2026-05-23T15:42:00Z');
    expect(md).toContain('| Case | Plants | sonnet-only | haiku-only |');
    expect(md).toContain('demo');
    expect(md).toContain('🟢'); // haiku-only is cheaper at same recall → win
  });

  it('flags a recall regression with 🔴', () => {
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 1, tp: 2, fn: 0 }),
        score({ config_name: 'haiku-only', recall: 0.5, tp: 1, fn: 1, cost: { ...score({ config_name: 'x' }).cost, cost_usd: 0.1 } }),
      ],
    });
    expect(md).toContain('🔴');
  });

  it('flags a cheaper-but-not-enough as 🟡', () => {
    const baseline = score({ config_name: 'sonnet-only', cost: { ...score({ config_name: 'x' }).cost, cost_usd: 1.0 } });
    const challenger = score({ config_name: 'opus-only', cost: { ...baseline.cost, cost_usd: 0.8 } });
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [baseline, challenger],
    });
    expect(md).toContain('🟡');
  });
});
