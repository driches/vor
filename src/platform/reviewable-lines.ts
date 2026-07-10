/**
 * Computes which lines of a pull request are addressable by a review comment.
 *
 * The current review contract targets the new-file side: added and context
 * lines can be anchored, while deleted lines cannot. Both GitHub and Bitbucket
 * expose that same right-side model even though their posting payloads differ.
 */

import type parseDiff from 'parse-diff';
import type { LineRange } from '../types.js';

export interface ReviewableLineMap {
  ranges: LineRange[];
  set: ReadonlySet<number>;
  addedSet: ReadonlySet<number>;
  text: Map<number, string>;
}

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
    }
  }

  return {
    ranges: collapseToRanges(set),
    set,
    addedSet,
    text,
  };
}

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

export function isLineReviewable(line: number, ranges: readonly LineRange[]): boolean {
  for (const [start, end] of ranges) {
    if (line >= start && line <= end) return true;
  }
  return false;
}

export function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(', ');
}

function stripDiffMarker(content: string): string {
  if (content.length === 0) return content;
  const first = content[0];
  return first === '+' || first === '-' || first === ' ' ? content.slice(1) : content;
}
