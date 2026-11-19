/**
 * Dedup utilities used by the shared review runner to collapse overlapping
 * findings before they reach a platform adapter.
 *
 * Two passes exist:
 *
 *   1. {@link dedupAcrossScanners} — across scanners (same PR run). Two
 *      different scanners may legitimately flag the same line for the same
 *      underlying issue (e.g. a generic-entropy secret pattern catching a
 *      credential the AWS-key pattern also catches). We keep one finding:
 *      the highest-confidence one, breaking ties by the order the scanners
 *      appear in the input array — that preserves the runner's stable
 *      ordering so metrics stay deterministic.
 *
 *   2. {@link dedupCommentsWithScannerPrecedence} — across scanner and AI
 *      comments before cap filtering. When both tracks report the same issue,
 *      the validated deterministic scanner finding is canonical and the
 *      overlapping AI comment is removed. Running this before caps is safe
 *      because the scanner finding can no longer be discarded in favor of an
 *      AI comment that is later capped out.
 *
 * Both passes are pure functions — they consume readonly inputs and produce
 * fresh arrays. Order of the output preserves first-appearance order from
 * the input so downstream rendering is deterministic.
 */
import type { Confidence } from '../types.js';
import type { ScanFinding } from './types.js';
import type { PostedComment } from '../types.js';

/**
 * Numeric ranking for confidence comparisons. Higher = more confident.
 * Defined inline here so this module stays decoupled from `types.ts`
 * (which doesn't currently export a confidence rank).
 */
const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Categories that describe the same security issue family even when the
 * scanner and agent choose different labels.
 *
 * Why `bug` is NOT in this set: it's too broad. A leaked-secret scanner
 * finding must not suppress a nearby, unrelated null-dereference comment
 * purely by line proximity. Non-security categories require an exact line
 * and category match.
 */
const SECURITY_ADJACENT_CATEGORIES: ReadonlySet<string> = new Set([
  'security',
  'vulnerability',
  'data-loss',
]);

/** Distance (in lines, absolute) within which a scanner finding and an AI
 *  comment are considered "same neighborhood." Matches the doc-comment in
 *  Task 7's description. */
const AI_OVERLAP_LINE_WINDOW = 3;

/**
 * Pick the highest-confidence finding among a pair, falling back to the
 * one provided first (the `incumbent`). The order-preserving tie-break is
 * what keeps the runner's output deterministic when two scanners produce
 * identical-confidence duplicates.
 */
function preferHigherConfidence(incumbent: ScanFinding, challenger: ScanFinding): ScanFinding {
  return CONFIDENCE_RANK[challenger.confidence] > CONFIDENCE_RANK[incumbent.confidence]
    ? challenger
    : incumbent;
}

/**
 * Pass 1: collapse duplicates produced by two or more scanners in the same
 * PR run.
 *
 * A duplicate is defined by EITHER of:
 *   - identical `fingerprint`, OR
 *   - identical `(file_path, line, rule_id)` triple.
 *
 * The fingerprint check is the primary key — scanners are encouraged to
 * generate fingerprints with the same shape for the same logical issue so
 * cross-scanner dedup happens cheaply. The triple is a fallback for the
 * (rare) case where two scanners report the same rule at the same site
 * without coordinating their fingerprint salts.
 */
export function dedupAcrossScanners(findings: readonly ScanFinding[]): ScanFinding[] {
  // We maintain two parallel indices because either match alone marks a dup.
  // `byKey` maps a dedup key → index into `out`. We update `out[idx]` in
  // place when a higher-confidence challenger arrives.
  const byFingerprint = new Map<string, number>();
  const byTriple = new Map<string, number>();
  const out: ScanFinding[] = [];
  // Tombstone set for slots we've merged away. Materialised at the end via
  // `.filter` so we keep indices stable during the loop (mutating `out`
  // mid-iteration would invalidate every map entry).
  const droppedSlots = new Set<number>();

  const tripleKey = (f: ScanFinding) => `${f.file_path} ${f.line} ${f.rule_id}`;

  for (const f of findings) {
    const fpIdx = byFingerprint.get(f.fingerprint);
    const trIdx = byTriple.get(tripleKey(f));

    // Case 1: neither key seen before — brand new finding.
    if (fpIdx === undefined && trIdx === undefined) {
      const idx = out.length;
      out.push(f);
      byFingerprint.set(f.fingerprint, idx);
      byTriple.set(tripleKey(f), idx);
      continue;
    }

    // Case 2: both keys hit, but DIFFERENT slots — `f` is a bridge that
    // links two previously-disjoint equivalence groups (e.g. scanner A
    // reported `(fp=X, t1)`, scanner B reported `(fp=Y, t2)`, and now `f`
    // arrives with `(fp=X, t2)`). Without this case the two prior findings
    // remain in `out` as separate entries even though they're conceptually
    // one issue. Merge by tombstoning the higher-index slot and
    // re-pointing every key from `drop → keep`.
    if (fpIdx !== undefined && trIdx !== undefined && fpIdx !== trIdx) {
      const keep = Math.min(fpIdx, trIdx);
      const drop = Math.max(fpIdx, trIdx);
      const winnerOfTwo = preferHigherConfidence(out[keep]!, out[drop]!);
      const winnerAll = preferHigherConfidence(winnerOfTwo, f);
      out[keep] = winnerAll;
      droppedSlots.add(drop);
      // Re-point any key currently pointing at `drop` so future finds
      // collapse into `keep`.
      for (const [k, v] of byFingerprint) if (v === drop) byFingerprint.set(k, keep);
      for (const [k, v] of byTriple) if (v === drop) byTriple.set(k, keep);
      // Ensure f's own keys point at `keep` too.
      byFingerprint.set(f.fingerprint, keep);
      byTriple.set(tripleKey(f), keep);
      continue;
    }

    // Case 3: single key hit (or both hit the same slot). Standard merge.
    const existingIdx = (fpIdx ?? trIdx) as number;
    const incumbent = out[existingIdx]!;
    const winner = preferHigherConfidence(incumbent, f);
    if (winner !== incumbent) {
      out[existingIdx] = winner;
      byFingerprint.set(winner.fingerprint, existingIdx);
      byTriple.set(tripleKey(winner), existingIdx);
    }
    // Either way the loser's keys are still pointed at `existingIdx` which
    // is correct — any future finding matching THOSE keys collapses here.
  }

  return out.filter((_f, i) => !droppedSlots.has(i));
}

/**
 * Pass 2: drop AI comments that overlap a deterministic scanner finding.
 * Scanner results are canonical when the two tracks disagree.
 *
 * Overlap criteria (ALL must hold) for an AI comment to be suppressed:
 *   - same `file_path`,
 *   - same `side` (LEFT vs RIGHT) — a LEFT-side AI comment anchors at the
 *     PR's BASE blob while a RIGHT-side scanner finding points at HEAD;
 *     they reference different code positions and must not cross-dedup,
 *   - `|scan.line - ai.line| <= 3`,
 *   - both categories are security-adjacent, OR both use the same category
 *     on the same line.
 *
 * Scanner comments are always returned unchanged. An AI comment with no
 * `source` is still treated as agent-originated for backward compatibility.
 */
export function dedupCommentsWithScannerPrecedence(
  comments: readonly PostedComment[],
): PostedComment[] {
  const scannerComments = comments.filter((comment) => comment.source?.kind === 'scanner');
  return comments.filter((comment) => {
    if (comment.source?.kind === 'scanner') return true;
    return !scannerComments.some((scanner) => commentsOverlap(scanner, comment));
  });
}

function commentsOverlap(scanner: PostedComment, agent: PostedComment): boolean {
  if (scanner.file_path !== agent.file_path || scanner.side !== agent.side) return false;

  const distance = Math.abs(scanner.line - agent.line);
  const securityOverlap =
    SECURITY_ADJACENT_CATEGORIES.has(scanner.category) &&
    SECURITY_ADJACENT_CATEGORIES.has(agent.category) &&
    distance <= AI_OVERLAP_LINE_WINDOW;
  const exactCategoryOverlap = scanner.category === agent.category && distance === 0;
  return securityOverlap || exactCategoryOverlap;
}
