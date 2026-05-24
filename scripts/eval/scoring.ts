/**
 * Score one run record against a case's truths.
 *
 * Match criteria (a finding F matches truth T when ALL hold):
 *   - F.file_path === T.file
 *   - F's commented range overlaps T's truth range with ±LINE_SLACK
 *     tolerance on either side. F's range is [F.start_line ?? F.line, F.line];
 *     T's range is T.line_range. Overlap test:
 *       findingStart <= truthEnd + slack  AND  findingEnd >= truthStart - slack
 *   - F.category ∈ T.category   (the truth declares the compatible category set)
 *
 * Each truth is matched at most once. We solve maximum bipartite matching by
 * augmenting paths so the result is order-independent and does not undercount
 * TPs when truth-finding compatibility sets overlap (a greedy pass would).
 * Unmatched findings become FPs ("unaligned"). Unmatched truths become FNs.
 *
 * Range-based matching (vs. previous end-line-only) accounts for multi-line
 * findings where the planted bug is near the start of the comment range but
 * the end line is outside the slack window. See PR #10 Codex P2 3295074806.
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
  // Build a compatibility matrix: compat[t][f] === true iff finding f satisfies
  // truth t's file + line-range (with slack) + category constraints.
  const T = input.truths.length;
  const F = input.findings.length;
  const compat: boolean[][] = [];
  for (let t = 0; t < T; t++) {
    const truth = input.truths[t]!;
    const [truthStart, truthEnd] = truth.line_range;
    const row: boolean[] = [];
    for (let i = 0; i < F; i++) {
      const finding = input.findings[i]!;
      // GitHub's PostedComment may carry a multi-line range via `start_line`;
      // a single-line comment has `start_line` absent and `line` carries the
      // single anchor. Treat the finding as [findingStart, findingEnd] and
      // test range overlap with slack on both ends.
      const findingStart = finding.start_line ?? finding.line;
      const findingEnd = finding.line;
      const overlaps =
        findingStart <= truthEnd + LINE_SLACK &&
        findingEnd >= truthStart - LINE_SLACK;
      const ok =
        finding.file_path === truth.file &&
        overlaps &&
        truth.category.includes(finding.category);
      row.push(ok);
    }
    compat.push(row);
  }

  // Maximum bipartite matching via augmenting paths.
  // matchFinding[t] = index of finding paired with truth t (-1 if unmatched)
  // matchTruth[f]   = index of truth paired with finding f (-1 if unmatched)
  const matchFinding: number[] = new Array(T).fill(-1);
  const matchTruth: number[] = new Array(F).fill(-1);

  function augment(t: number, visited: boolean[]): boolean {
    for (let f = 0; f < F; f++) {
      if (!compat[t]![f] || visited[f]) continue;
      visited[f] = true;
      if (matchTruth[f] === -1 || augment(matchTruth[f]!, visited)) {
        matchFinding[t] = f;
        matchTruth[f] = t;
        return true;
      }
    }
    return false;
  }

  for (let t = 0; t < T; t++) {
    const visited: boolean[] = new Array(F).fill(false);
    augment(t, visited);
  }

  // Build outcomes (one per truth, in truth order) from the final matching.
  const outcomes: TruthOutcome[] = [];
  for (let t = 0; t < T; t++) {
    const f = matchFinding[t]!;
    if (f >= 0) {
      outcomes.push({ truth: input.truths[t]!, status: 'matched', finding: input.findings[f]! });
    } else {
      outcomes.push({ truth: input.truths[t]!, status: 'missed' });
    }
  }
  const matchedFindings = new Set<number>(matchFinding.filter((f) => f >= 0));

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
