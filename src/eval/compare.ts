/**
 * Compare two sets of NormalizedFinding (e.g. ours vs. Codex) and emit a
 * structured agreement report. Intentionally NOT F1 against a ground truth —
 * Codex isn't truth, and the same bug often gets flagged on different but
 * related lines. See docs/golden-dataset.md ("Why not F1").
 *
 * Matching algorithm (greedy nearest-match):
 *   1. Annotate each finding with `hunk_id` derived from the unified diff.
 *   2. For each Codex finding, find the closest Ours finding in the same
 *      hunk, but only within `hunkLineTolerance`; if none, fall back to
 *      ±lineTolerance on the same file path.
 *   3. The closest unmatched Ours finding wins.
 *   4. Remaining Ours findings = `our_only`. Remaining Codex = `codex_only`.
 *
 * Outputs `matched` pairs, `our_only`, `codex_only`, a severity-delta
 * histogram (signed rank distance between matched pairs), and a category
 * co-occurrence list (descriptive, not scored — categories don't align 1:1
 * across bots).
 */

import parseDiff from 'parse-diff';
import { SEVERITY_RANK, type Category, type Severity } from '../types.js';
import type { NormalizedFinding } from './finding.js';

export interface CompareInput {
  ours: NormalizedFinding[];
  codex: NormalizedFinding[];
  /** Raw unified diff used to compute hunk IDs. */
  diff: string;
  /** Maximum line distance for a fallback line-based match. Default 3. */
  lineTolerance?: number;
  /** Maximum line distance for same-hunk matches. Default 25. */
  hunkLineTolerance?: number;
}

export interface MatchedPair {
  ours: NormalizedFinding;
  codex: NormalizedFinding;
  matchedBy: 'hunk' | 'line';
  lineDistance: number;
}

export interface CategoryCoOccurrence {
  ours: Category | 'unknown';
  codex: Category | 'unknown';
  count: number;
}

export interface CompareResult {
  matched: MatchedPair[];
  ours_only: NormalizedFinding[];
  codex_only: NormalizedFinding[];
  /** Signed delta from RANK(codex) - RANK(ours). 0 = equal severity. */
  severity_deltas: Record<string, number>;
  category_co_occurrence: CategoryCoOccurrence[];
  totals: {
    ours: number;
    codex: number;
    matched: number;
    /** matched / max(ours, codex). 1.0 = perfect agreement, 0 = no overlap. */
    agreement_rate: number;
  };
}

export function compare(input: CompareInput): CompareResult {
  const lineTolerance = input.lineTolerance ?? 3;
  const hunkLineTolerance = input.hunkLineTolerance ?? 25;
  const hunkIndex = buildHunkIndex(input.diff);
  const ours = annotateHunks(input.ours, hunkIndex);
  const codex = annotateHunks(input.codex, hunkIndex);

  const oursPool = ours.map((f, idx) => ({ f, idx, taken: false }));
  const matched: MatchedPair[] = [];
  const codexOnly: NormalizedFinding[] = [];

  for (const cFinding of codex) {
    const candidates = oursPool.filter(
      (entry) => !entry.taken && entry.f.file_path === cFinding.file_path,
    );

    // Pass 1: same file, same hunk_id (when both have one)
    let best: { entry: (typeof oursPool)[number]; dist: number; how: 'hunk' | 'line' } | null =
      null;
    if (cFinding.hunk_id) {
      for (const entry of candidates) {
        if (entry.f.hunk_id !== cFinding.hunk_id) continue;
        const dist = Math.abs(entry.f.line - cFinding.line);
        if (dist > hunkLineTolerance) continue;
        if (!best || dist < best.dist) best = { entry, dist, how: 'hunk' };
      }
    }

    // Pass 2: fall back to line-distance tolerance
    if (!best) {
      for (const entry of candidates) {
        const dist = Math.abs(entry.f.line - cFinding.line);
        if (dist > lineTolerance) continue;
        if (!best || dist < best.dist) best = { entry, dist, how: 'line' };
      }
    }

    if (best) {
      best.entry.taken = true;
      matched.push({
        ours: best.entry.f,
        codex: cFinding,
        matchedBy: best.how,
        lineDistance: best.dist,
      });
    } else {
      codexOnly.push(cFinding);
    }
  }

  const oursOnly = oursPool.filter((e) => !e.taken).map((e) => e.f);

  return {
    matched,
    ours_only: oursOnly,
    codex_only: codexOnly,
    severity_deltas: computeSeverityDeltas(matched),
    category_co_occurrence: computeCategoryCoOccurrence(matched),
    totals: {
      ours: ours.length,
      codex: codex.length,
      matched: matched.length,
      agreement_rate:
        ours.length === 0 && codex.length === 0
          ? 1
          : matched.length / Math.max(ours.length, codex.length),
    },
  };
}

/**
 * Annotate findings with a `hunk_id` derived from the diff. Returns NEW
 * objects — does not mutate input.
 */
export function annotateHunks(
  findings: readonly NormalizedFinding[],
  hunkIndex: HunkIndex,
): NormalizedFinding[] {
  return findings.map((f) => {
    const hid = findHunkId(f.file_path, f.line, hunkIndex);
    return hid ? { ...f, hunk_id: hid } : f;
  });
}

export type HunkIndex = Map<string, Array<{ start: number; end: number; index: number }>>;

export function buildHunkIndex(diff: string): HunkIndex {
  const out: HunkIndex = new Map();
  if (!diff || diff.trim().length === 0) return out;
  const files = parseDiff(diff);
  for (const file of files) {
    const path = file.to && file.to !== '/dev/null' ? file.to : (file.from ?? '');
    if (!path) continue;
    const hunks = file.chunks.map((c, i) => ({
      start: c.newStart,
      end: c.newStart + Math.max(0, c.newLines - 1),
      index: i,
    }));
    out.set(path, hunks);
  }
  return out;
}

function findHunkId(filePath: string, line: number, index: HunkIndex): string | undefined {
  const hunks = index.get(filePath);
  if (!hunks) return undefined;
  const h = hunks.find((h) => line >= h.start && line <= h.end);
  return h ? `${filePath}#hunk_${h.index}` : undefined;
}

function computeSeverityDeltas(pairs: readonly MatchedPair[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pairs) {
    const rOurs = severityRank(p.ours.severity);
    const rCodex = severityRank(p.codex.severity);
    if (rOurs == null || rCodex == null) {
      out['unknown'] = (out['unknown'] ?? 0) + 1;
      continue;
    }
    const delta = rCodex - rOurs;
    const key = delta > 0 ? `+${delta}` : String(delta);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function severityRank(s: Severity | 'unknown'): number | null {
  if (s === 'unknown') return null;
  return SEVERITY_RANK[s];
}

function computeCategoryCoOccurrence(pairs: readonly MatchedPair[]): CategoryCoOccurrence[] {
  const tally = new Map<string, CategoryCoOccurrence>();
  for (const p of pairs) {
    const key = `${p.ours.category}|${p.codex.category}`;
    const existing = tally.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      tally.set(key, { ours: p.ours.category, codex: p.codex.category, count: 1 });
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}
