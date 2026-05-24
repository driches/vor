/**
 * Computes which lines of a PR are addressable by a review comment.
 *
 * THE source of truth: an inline comment may only be posted on a line that
 * appears in this set. The validator rejects everything else.
 *
 * GitHub allows comments on:
 *   - RIGHT side: any `+` (added) or ` ` (context) line in a hunk
 *   - LEFT side:  any `-` (deleted) or ` ` (context) line in a hunk
 *
 * This module focuses on RIGHT side (the new file), which is what code review
 * comments should target 99% of the time. LEFT-side support can be added later.
 */

import type parseDiff from 'parse-diff';
import type { LineRange } from '../types.js';

export interface ReviewableLineMap {
  /** Inclusive ranges of reviewable lines on HEAD, e.g., [[12,15], [23,30]]. */
  ranges: LineRange[];
  /** Set of every reviewable line for O(1) lookup (added + context). */
  set: ReadonlySet<number>;
  /** Set of lines on HEAD that were ADDED by the PR (the '+' lines only).
   *  Strict subset of `set` — context lines around hunks are NOT in this set. */
  addedSet: ReadonlySet<number>;
  /** Map of line number → exact text content on HEAD (used to verify suggestion ≠ existing). */
  text: Map<number, string>;
}

/**
 * Compute reviewable lines for a single file from its parsed diff chunks.
 * Returns RIGHT-side (new file) reviewable lines only.
 */
export function computeReviewableLines(chunks: parseDiff.Chunk[]): ReviewableLineMap {
  const set = new Set<number>();
  const addedSet = new Set<number>();
  const text = new Map<number, string>();

  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      if (change.type === 'add') {
        set.add(change.ln);
        addedSet.add(change.ln);
        text.set(change.ln, stripDiffMarker(change.content));
      } else if (change.type === 'normal') {
        set.add(change.ln2);
        text.set(change.ln2, stripDiffMarker(change.content));
      }
      // 'del' changes are LEFT-side only — skip for RIGHT-side review comments.
    }
  }

  return {
    ranges: collapseToRanges(set),
    set,
    addedSet,
    text,
  };
}

/** Convert a set of line numbers to inclusive [start, end] ranges. */
export function collapseToRanges(lines: Iterable<number>): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const ranges: [number, number][] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === end + 1) {
      end = n;
    } else {
      ranges.push([start, end]);
      start = n;
      end = n;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

/** True if `line` falls within any range in `ranges`. */
export function isLineReviewable(line: number, ranges: readonly LineRange[]): boolean {
  for (const [s, e] of ranges) {
    if (line >= s && line <= e) return true;
  }
  return false;
}

/** Human-friendly format for ranges, e.g., "12-15, 23-30, 89". */
export function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`)).join(', ');
}

/**
 * parse-diff includes the leading +/- /space in `content`. Strip it.
 */
function stripDiffMarker(content: string): string {
  if (content.length === 0) return content;
  const first = content[0];
  if (first === '+' || first === '-' || first === ' ') {
    return content.slice(1);
  }
  return content;
}
