/**
 * Dedup utilities used by the runner + orchestrator to collapse overlapping
 * findings before they hit the GitHub comment posting path.
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
 *   2. {@link dedupKeptScannerComments} — across the AI agent's surviving
 *      comments, AFTER the final filter caps have run. When a scanner
 *      flags the same neighborhood as an AI security comment, the AI
 *      usually has richer context and a more digestible explanation, so we
 *      prefer it. The big exception is `dependency-cve`: those findings
 *      carry hard, verifiable evidence (CVE id, version range, fix version)
 *      that the AI cannot supply, so they are NEVER suppressed by AI overlap.
 *
 *      Why post-filter? An earlier "predict-then-dedup" version ran dedup
 *      against AI comments PREDICTED to survive the caps. That was still
 *      wrong: if a predicted-survivor AI got bumped out of the combined cap
 *      by other scanner findings, its scanner counterpart had already been
 *      dropped by dedup and the line area silently lost ALL signal. Moving
 *      dedup AFTER the cap means scanner findings only lose to AI comments
 *      that actually post. See Codex P1 on PR #8.
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
 * Categories that overlap "security-adjacent" enough that an AI comment in
 * one of these should suppress a co-located scanner finding. Anything else
 * (readability, naming, generic `bug`, etc.) is unrelated and we keep both.
 *
 * Why `bug` is NOT in this set: it's too broad. A nearby unrelated bug
 * comment (e.g. a null-deref note) would suppress a real scanner finding
 * (e.g. a leaked secret) purely by line proximity, hiding security signal.
 * We only suppress against categories that genuinely cover security ground.
 */
const AI_SECURITY_ADJACENT_CATEGORIES: ReadonlySet<string> = new Set([
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
function preferHigherConfidence(
  incumbent: ScanFinding,
  challenger: ScanFinding,
): ScanFinding {
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
export function dedupAcrossScanners(
  findings: readonly ScanFinding[],
): ScanFinding[] {
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
 * Pass 2 (post-filter): drop scanner-sourced comments in the kept list that
 * overlap a surviving AI comment in a security-adjacent category.
 *
 * This runs AFTER {@link filterComments} so the only AI comments scanner
 * findings can lose to are the ones that ACTUALLY post (per Codex P1). The
 * earlier predict-then-dedup approach was still wrong: if a predicted-
 * survivor AI got bumped from the combined cap by other scanner findings,
 * its scanner counterpart had already been dropped and the line area
 * silently lost ALL security signal.
 *
 * Overlap criteria (ALL must hold) for a scanner comment to be suppressed:
 *   - same `file_path`,
 *   - `|scan.line - ai.line| <= 3`,
 *   - the AI comment's `category` is in
 *     {'security','vulnerability','data-loss'}.
 *
 * Hard exception: scanner findings whose `source.scanner === 'dependency-cve'`
 * are NEVER suppressed by an AI overlap — they carry verifiable CVE
 * metadata the AI cannot reproduce, and we'd rather have a duplicate
 * comment than silently drop a CVE.
 *
 * Non-scanner comments (i.e. AI comments) are returned unchanged.
 */
export function dedupKeptScannerComments(
  kept: readonly PostedComment[],
): PostedComment[] {
  // Snapshot surviving AI comments once so the per-scanner overlap check
  // doesn't re-scan the full list each iteration.
  const survivingAi = kept.filter((c) => c.source?.kind !== 'scanner');
  return kept.filter((c) => {
    if (c.source?.kind !== 'scanner') return true;
    if (c.source.scanner === 'dependency-cve') return true;
    return !survivingAi.some(
      (ai) =>
        ai.file_path === c.file_path &&
        Math.abs(ai.line - c.line) <= AI_OVERLAP_LINE_WINDOW &&
        AI_SECURITY_ADJACENT_CATEGORIES.has(ai.category),
    );
  });
}
