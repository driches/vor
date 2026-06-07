/**
 * Score one run record against a case's truths.
 *
 * Match criteria (a finding F matches truth T when ALL hold):
 *   - F.side === 'RIGHT' (truths are anchored to the after/ snapshot; LEFT
 *     comments target base/deleted lines and can't legitimately satisfy a
 *     truth there even if the line numbers happen to overlap)
 *   - F.file_path === T.file
 *   - F's commented range overlaps T's truth range with ±LINE_SLACK
 *     tolerance on either side. F's range is [F.start_line ?? F.line, F.line];
 *     T's range is T.line_range. Overlap test:
 *       findingStart <= truthEnd + slack  AND  findingEnd >= truthStart - slack
 *   - F.category is compatible with T.category / T.bug_type
 *
 * Each truth is matched at most once. We solve maximum bipartite matching by
 * augmenting paths so the result is order-independent and does not undercount
 * TPs when truth-finding compatibility sets overlap (a greedy pass would).
 * Unmatched findings become FPs ("unaligned"). Unmatched truths become FNs.
 *
 * Range-based matching (vs. previous end-line-only) accounts for multi-line
 * findings where the planted bug is near the start of the comment range but
 * the end line is outside the slack window. See PR #10 Codex P2 3295074806.
 *
 * Side-aware matching prevents LEFT-side comments from inflating recall when
 * line numbers coincidentally overlap an after/-anchored truth. See PR #10
 * Codex P2 3295113234.
 */
import type { PostedComment, Category } from '../../src/types.js';
import type { RunRecord, TruthEntry, ScoreResult, TruthOutcome } from './types.js';

const LINE_SLACK = 3;

// `security` and `vulnerability` name the same class of finding; the LLM picks
// one or the other for the same bug run-to-run. Treat them as interchangeable
// when matching a finding's category against a truth's allow-list.
const SECURITY_FAMILY: ReadonlySet<Category> = new Set<Category>(['security', 'vulnerability']);

export interface ScoreInput {
  case_id: string;
  config_name: string;
  truths: readonly TruthEntry[];
  findings: readonly PostedComment[];
  cost: RunRecord['cost'];
}

export function scoreRun(input: ScoreInput): ScoreResult {
  // Collapse scanner fan-out before matching. A deterministic scanner that
  // emits several rows for one underlying issue at one location (e.g. multiple
  // OSV CVEs for a single vulnerable dependency, all anchored to the same
  // lockfile line) should count once, not N times. Keep one representative per
  // (scanner, file, line); the rest are `duplicates`, excluded from precision.
  // Agent findings are never collapsed — a co-located LLM comment is a distinct
  // signal precision must measure, so it falls through to the matcher and counts
  // as a FP when it doesn't match a truth. Earlier the scorer kept every row and
  // then treated any unmatched-but-truth-compatible finding as a duplicate,
  // which silently hid co-located agent noise. Codex P2 3370136471.
  const findings: PostedComment[] = [];
  const duplicates: PostedComment[] = [];
  const seenScannerKeys = new Set<string>();
  for (const f of input.findings) {
    if (f.source?.kind === 'scanner') {
      const key = `${f.source.scanner}|${f.file_path}|${f.start_line ?? f.line}|${f.line}`;
      if (seenScannerKeys.has(key)) {
        duplicates.push(f);
        continue;
      }
      seenScannerKeys.add(key);
    }
    findings.push(f);
  }

  // Build a compatibility matrix: compat[t][f] === true iff finding f satisfies
  // truth t's file + line-range (with slack) + category constraints.
  const T = input.truths.length;
  const F = findings.length;
  const compat: boolean[][] = [];
  for (let t = 0; t < T; t++) {
    const truth = input.truths[t]!;
    const [truthStart, truthEnd] = truth.line_range;
    const row: boolean[] = [];
    for (let i = 0; i < F; i++) {
      const finding = findings[i]!;
      // GitHub's PostedComment may carry a multi-line range via `start_line`;
      // a single-line comment has `start_line` absent and `line` carries the
      // single anchor. Treat the finding as [findingStart, findingEnd] and
      // test range overlap with slack on both ends.
      const findingStart = finding.start_line ?? finding.line;
      const findingEnd = finding.line;
      const overlaps =
        findingStart <= truthEnd + LINE_SLACK && findingEnd >= truthStart - LINE_SLACK;
      const ok =
        finding.side === 'RIGHT' &&
        finding.file_path === truth.file &&
        overlaps &&
        categoryMatches(truth, finding);
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
      outcomes.push({ truth: input.truths[t]!, status: 'matched', finding: findings[f]! });
    } else {
      outcomes.push({ truth: input.truths[t]!, status: 'missed' });
    }
  }
  const matchedFindings = new Set<number>(matchFinding.filter((f) => f >= 0));

  const tp = outcomes.filter((o) => o.status === 'matched').length;
  const fn = outcomes.length - tp;
  // Any kept finding (after scanner fan-out was collapsed above) that didn't
  // match a truth is a false positive — including a co-located agent comment.
  const unaligned = findings.filter((_f, i) => !matchedFindings.has(i));
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
    unaligned,
    duplicates,
    cost: input.cost,
  };
}

function categoryMatches(truth: TruthEntry, finding: PostedComment): boolean {
  if (truth.category.includes(finding.category)) return true;
  // `security` ⇔ `vulnerability`: the LLM labels the same security finding
  // either way from run to run, so a truth that allows one must accept the
  // other. Without this, recall on security/vuln cases flips on wording alone
  // (a correctly-located SQLi labeled `vulnerability` scored as a full miss
  // against a `[security, bug]` truth).
  if (SECURITY_FAMILY.has(finding.category) && truth.category.some((c) => SECURITY_FAMILY.has(c))) {
    return true;
  }
  // `Array.forEach(async ...)` is both async-control-flow and race behavior:
  // the outer function returns before the inner awaits settle. Treat an LLM's
  // `race-condition` categorization as compatible with the existing planted
  // truth files, which predate that category in their allowed set.
  if (truth.bug_type === 'sync-in-async-loop' && finding.category === 'race-condition') {
    return true;
  }
  return false;
}
