/**
 * Score one run record against a case's truths.
 *
 * Match criteria (a finding F matches truth T when ALL hold):
 *   - F.file_path === T.file
 *   - |F.line - T.line_range[0]| <= 3
 *   - F.category ∈ T.category   (the truth declares the compatible category set)
 *
 * Each truth is matched at most once (greedy first-match). Unmatched findings
 * become FPs ("unaligned"). Unmatched truths become FNs.
 */
import type { PostedComment } from '../../src/types.js';
import type { RunRecord, TruthEntry, ScoreResult, TruthOutcome } from './types.js';

const LINE_SLACK = 3;

export interface ScoreInput {
  case_id: string;
  config_name: string;
  truths: readonly TruthEntry[];
  findings: readonly PostedComment[];
  cost: RunRecord['cost'];
}

export function scoreRun(input: ScoreInput): ScoreResult {
  const matchedFindings = new Set<number>();
  const outcomes: TruthOutcome[] = [];

  for (const truth of input.truths) {
    let matchedIdx = -1;
    for (let i = 0; i < input.findings.length; i++) {
      if (matchedFindings.has(i)) continue;
      const f = input.findings[i]!;
      if (f.file_path !== truth.file) continue;
      if (Math.abs(f.line - truth.line_range[0]) > LINE_SLACK) continue;
      if (!truth.category.includes(f.category)) continue;
      matchedIdx = i;
      break;
    }
    if (matchedIdx >= 0) {
      matchedFindings.add(matchedIdx);
      outcomes.push({ truth, status: 'matched', finding: input.findings[matchedIdx]! });
    } else {
      outcomes.push({ truth, status: 'missed' });
    }
  }

  const tp = outcomes.filter((o) => o.status === 'matched').length;
  const fn = outcomes.length - tp;
  const unaligned = input.findings.filter((_f, i) => !matchedFindings.has(i));
  const fp = unaligned.length;

  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const cost_per_tp_usd = input.cost.cost_usd / Math.max(tp, 1);

  return {
    case_id: input.case_id,
    config_name: input.config_name,
    tp,
    fn,
    fp,
    recall,
    precision,
    f1,
    cost_per_tp_usd,
    outcomes,
    unaligned: [...unaligned],
    cost: input.cost,
  };
}
