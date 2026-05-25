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
      provider: 'anthropic',
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

  it('throws when one case row is missing the baseline run', () => {
    // Regression for PR #10 Codex P2 3295092572. The previous report renderer
    // silently rendered `plants: 0` and a baseline-less challenger cell when
    // a specific case had no baseline run — making an incomplete eval matrix
    // look valid. The check now happens per-case.
    const baselineCost = score({ config_name: 'x' }).cost;
    expect(() =>
      renderSummaryReport({
        timestamp: '2026-05-23T15:42:00Z',
        baseline_config: 'sonnet-only',
        scores: [
          // case-A: baseline + challenger both ran.
          score({ case_id: 'case-A', config_name: 'sonnet-only' }),
          score({ case_id: 'case-A', config_name: 'haiku-only', cost: { ...baselineCost, cost_usd: 0.1 } }),
          // case-B: baseline DIDN'T run (challenger-only).
          score({ case_id: 'case-B', config_name: 'haiku-only' }),
        ],
      }),
    ).toThrow(/case-B/);
  });

  it('throws when baseline_config is not present in scores', () => {
    // Regression for PR #10 comment 3295052527. A misspelled or missing
    // baseline silently rendered a useless report (every row showed
    // `plants: 0` and every challenger column hit the "no baseline" branch).
    expect(() =>
      renderSummaryReport({
        timestamp: '2026-05-23T15:42:00Z',
        baseline_config: 'sonnet-only', // doesn't exist in scores
        scores: [
          score({ config_name: 'opus-only' }),
          score({ config_name: 'haiku-only' }),
        ],
      }),
    ).toThrow(/baseline_config.*not found/);
  });

  it('flags same-recall + cost-regressed as 🔴 (not ⚪)', () => {
    // Regression for PR #10 comment 3295026563. The previous report logic
    // had a dead-code `⚪` branch that masked this case: when a challenger
    // matches the baseline's recall but costs >5% more, the cell silently
    // rendered as ⚪ ("inconclusive") even though it's an unambiguous cost
    // regression on the only axis the operator cares about when recall is
    // flat.
    const baselineCost = score({ config_name: 'x' }).cost;
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 1.0, tp: 10, fn: 0 }),
        score({
          config_name: 'opus-only',
          recall: 1.0, // identical recall
          tp: 10,
          fn: 0,
          // Cost is 50% higher than baseline ($0.75 vs $0.50) — well past the
          // ±5% inconclusive band.
          cost: { ...baselineCost, cost_usd: 0.75 },
        }),
      ],
    });
    expect(md).toContain('🔴');
  });

  it('flags recall-improved + cost-regressed as ⚪ (ambiguous tradeoff, not a clear win)', () => {
    // Regression for PR #10 dogfood IMPORTANT 3295156531. Previously the
    // `recall improved → 🟡` branch fired for ANY recall gain, even when
    // the challenger cost >5% more — operator sees apparent win where it
    // was actually a mixed result. Now: recall-up + cost-up significantly
    // → ⚪ (ambiguous); recall-up + cost-neutral or down → 🟡 (genuine win).
    const baselineCost = score({ config_name: 'x' }).cost;
    const md = renderSummaryReport({
      timestamp: '2026-05-23T15:42:00Z',
      baseline_config: 'sonnet-only',
      scores: [
        score({ config_name: 'sonnet-only', recall: 0.7, tp: 7, fn: 3 }),
        score({
          config_name: 'opus-only',
          recall: 0.9, // +20pp recall (recall-improved branch fires)
          tp: 9,
          fn: 1,
          // Cost is 2× baseline — well past the ±5% inconclusive band.
          cost: { ...baselineCost, cost_usd: 1.0 },
        }),
      ],
    });
    expect(md).toContain('⚪');
    expect(md).not.toContain('🟡'); // the apparent-win miscolor is gone
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
