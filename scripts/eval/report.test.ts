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

  it('flags any recall drop below baseline as 🔴 (no epsilon softening)', () => {
    // Regression for PR #10 comment 3294915018. A small recall drop (e.g.
    // 0.98 vs 1.0 = 2pp, well within the legacy 5% epsilon) must still be
    // 🔴 — the spec says regression is strict `recall < baseline`.
    const baselineCost = score({ config_name: 'x' }).cost;
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 1.0, tp: 50, fn: 0 }),
        score({
          config_name: 'haiku-only',
          recall: 0.98,
          tp: 49,
          fn: 1,
          cost: { ...baselineCost, cost_usd: 0.1 },
        }),
      ],
    });
    expect(md).toContain('🔴');
    expect(md).not.toContain('🟢');
  });

  it('flags recall-improved + cost-neutral as 🟡 (not ⚪)', () => {
    // Regression for PR #10 comment 3294976845. The spec's 4 cells don't
    // cover "recall improved while cost is roughly flat". The default ⚪
    // would silently misrepresent a genuine recall win — surface it as 🟡
    // so the reviewer can spot the improvement.
    const baselineCost = score({ config_name: 'x' }).cost;
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 0.7, tp: 7, fn: 3 }),
        score({
          config_name: 'haiku-only',
          recall: 0.9, // +20pp recall — well outside ±5%
          tp: 9,
          fn: 1,
          // Same cost ($0.50 == baseline $0.50) — within ±5% on cost.
          cost: { ...baselineCost, cost_usd: 0.5 },
        }),
      ],
    });
    expect(md).toContain('🟡');
    expect(md).not.toContain('⚪');
  });
});
