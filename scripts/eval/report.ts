/**
 * Render a markdown summary comparing each config against a baseline.
 *
 * Win/loss colors (per the design spec, "same recall, lower cost"):
 *   🟢 — recall ≥ baseline AND cost < baseline × 0.75
 *   🟡 — recall ≥ baseline AND (cost < baseline  OR  recall improved by >5pp)
 *   🔴 — recall < baseline  OR  (recall flat AND cost up by >5%)
 *   ⚪ — within ±5% on both axes
 *
 * 🔴 covers regression on EITHER axis: a recall drop is the spec's strict
 * case, and "same recall but the challenger costs >5% more" is also a
 * meaningful regression that the dogfood reviewer (PR #10 comment
 * 3295026563) called out should not silently render as ⚪.
 */
import type { ScoreResult } from './types.js';

export interface RenderSummaryInput {
  timestamp: string;
  baseline_config: string;
  scores: readonly ScoreResult[];
}

const COST_WIN_RATIO = 0.75;
const INCONCLUSIVE_EPSILON = 0.05;

export function renderSummaryReport(input: RenderSummaryInput): string {
  const cases = unique(input.scores.map((s) => s.case_id));
  const configs = unique(input.scores.map((s) => s.config_name));
  // Fail fast if the named baseline isn't present in `scores`. A misspelled
  // baseline_config or a missing baseline run otherwise renders a table
  // where every challenger column shows the "no baseline available" branch
  // and `plants` silently shows 0 for every row — looks like a valid
  // report but every comparison is meaningless. See PR #10 comment 3295052527.
  if (!configs.includes(input.baseline_config)) {
    throw new Error(
      `baseline_config "${input.baseline_config}" not found in scores. ` +
        `Available configs: ${configs.join(', ') || '(none)'}`,
    );
  }
  const get = (caseId: string, cfg: string): ScoreResult | undefined =>
    input.scores.find((s) => s.case_id === caseId && s.config_name === cfg);

  const lines: string[] = [];
  lines.push(`# Eval run ${input.timestamp}`);
  lines.push('');
  lines.push(`Baseline: \`${input.baseline_config}\``);
  lines.push('');
  lines.push(`| Case | Plants | ${configs.join(' | ')} |`);
  lines.push(`| --- | --- | ${configs.map(() => '---').join(' | ')} |`);
  for (const caseId of cases) {
    const baseline = get(caseId, input.baseline_config);
    const plants = baseline ? baseline.tp + baseline.fn : 0;
    const row: string[] = [caseId, String(plants)];
    for (const cfg of configs) {
      const s = get(caseId, cfg);
      if (!s) {
        row.push('—');
        continue;
      }
      if (cfg === input.baseline_config) {
        row.push(`R ${pct(s.recall)} / $${s.cost.cost_usd.toFixed(2)} (base)`);
      } else if (!baseline) {
        row.push(`R ${pct(s.recall)} / $${s.cost.cost_usd.toFixed(2)}`);
      } else {
        row.push(formatCell(s, baseline));
      }
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatCell(s: ScoreResult, baseline: ScoreResult): string {
  // Strict comparison: any recall drop below baseline is a 🔴 regression.
  // The earlier `>= baseline.recall - INCONCLUSIVE_EPSILON` softened this and
  // let a 4pp drop sneak through as ⚪. See PR #10 comment 3294915018.
  const recallOK = s.recall >= baseline.recall;
  const recallEqual = Math.abs(s.recall - baseline.recall) <= INCONCLUSIVE_EPSILON;
  const costRatio = baseline.cost.cost_usd === 0 ? 1 : s.cost.cost_usd / baseline.cost.cost_usd;
  let icon = '⚪';
  if (!recallOK) icon = '🔴';
  else if (costRatio < COST_WIN_RATIO) icon = '🟢';
  else if (costRatio < 1 - INCONCLUSIVE_EPSILON) icon = '🟡';
  // Spec's 4 cells don't cover "recall improved + cost neutral". The default
  // ⚪ would silently misrepresent a recall win. Surface it as 🟡 so a
  // genuine recall improvement is visible even when cost is roughly flat.
  // See PR #10 comment 3294976845.
  else if (!recallEqual && s.recall > baseline.recall) icon = '🟡';
  // Same-recall-but-cost-regressed should not silently render as ⚪. The
  // previous branch here unconditionally set `⚪` (a no-op since that's
  // already the default), masking the case where a challenger keeps recall
  // flat but pays >5% more. Flag it as 🔴 — it's a regression on the cost
  // axis. See PR #10 comment 3295026563.
  else if (recallEqual && costRatio > 1 + INCONCLUSIVE_EPSILON) icon = '🔴';
  const recallDelta =
    s.recall >= baseline.recall
      ? `+${pct(s.recall - baseline.recall)}`
      : `-${pct(baseline.recall - s.recall)}`;
  const costPct = Math.round((costRatio - 1) * 100);
  const costStr = costPct > 0 ? `+${costPct}%` : `${costPct}%`;
  return `R ${pct(s.recall)} (${recallDelta}) / $${s.cost.cost_usd.toFixed(2)} (${costStr}) ${icon}`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function unique<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
