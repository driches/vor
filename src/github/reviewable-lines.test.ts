import { describe, expect, it } from 'vitest';
import {
  collapseToRanges,
  computeReviewableLines,
  formatRanges,
  isLineReviewable,
} from './reviewable-lines.js';

describe('collapseToRanges', () => {
  it('returns empty for empty input', () => {
    expect(collapseToRanges([])).toEqual([]);
  });

  it('returns single range for contiguous input', () => {
    expect(collapseToRanges([5, 6, 7, 8])).toEqual([[5, 8]]);
  });

  it('returns single point ranges for isolated values', () => {
    expect(collapseToRanges([3, 10, 20])).toEqual([
      [3, 3],
      [10, 10],
      [20, 20],
    ]);
  });

  it('handles unordered input', () => {
    expect(collapseToRanges([8, 5, 7, 6])).toEqual([[5, 8]]);
  });

  it('deduplicates', () => {
    expect(collapseToRanges([1, 1, 2, 2, 3])).toEqual([[1, 3]]);
  });

  it('mixes ranges and isolated values', () => {
    expect(collapseToRanges([1, 2, 3, 7, 9, 10])).toEqual([
      [1, 3],
      [7, 7],
      [9, 10],
    ]);
  });
});

describe('isLineReviewable', () => {
  const ranges = [
    [10, 12],
    [20, 25],
  ] as [number, number][];

  it('returns true for line inside a range', () => {
    expect(isLineReviewable(11, ranges)).toBe(true);
    expect(isLineReviewable(22, ranges)).toBe(true);
  });

  it('returns true for range boundaries', () => {
    expect(isLineReviewable(10, ranges)).toBe(true);
    expect(isLineReviewable(25, ranges)).toBe(true);
  });

  it('returns false for line outside ranges', () => {
    expect(isLineReviewable(9, ranges)).toBe(false);
    expect(isLineReviewable(15, ranges)).toBe(false);
    expect(isLineReviewable(100, ranges)).toBe(false);
  });

  it('returns false for empty ranges', () => {
    expect(isLineReviewable(5, [])).toBe(false);
  });
});

describe('formatRanges', () => {
  it('formats multiple ranges with comma', () => {
    expect(formatRanges([[5, 8], [12, 12], [20, 30]])).toBe('5-8, 12, 20-30');
  });

  it('collapses single-line ranges to single number', () => {
    expect(formatRanges([[42, 42]])).toBe('42');
  });

  it('returns empty for no ranges', () => {
    expect(formatRanges([])).toBe('');
  });
});

describe('computeReviewableLines', () => {
  it('returns empty for no chunks (binary file)', () => {
    const map = computeReviewableLines([]);
    expect(map.ranges).toEqual([]);
    expect(map.set.size).toBe(0);
    expect(map.text.size).toBe(0);
  });

  it('includes added and context lines (RIGHT side)', () => {
    const map = computeReviewableLines([
      {
        content: '@@ -1,3 +1,4 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        changes: [
          { type: 'normal', ln1: 1, ln2: 1, normal: true, content: ' a' },
          { type: 'add', add: true, ln: 2, content: '+b' },
          { type: 'normal', ln1: 2, ln2: 3, normal: true, content: ' c' },
          { type: 'normal', ln1: 3, ln2: 4, normal: true, content: ' d' },
        ],
      },
    ]);
    expect(map.set).toEqual(new Set([1, 2, 3, 4]));
    expect(map.text.get(2)).toBe('b');
    expect(map.text.get(1)).toBe('a');
  });

  it('separates added-only lines from context lines via addedSet', () => {
    // addedSet contains ONLY '+' lines (lines this PR actually added). Context
    // lines (' ') land in the broader `set` but not in `addedSet`. Scanners
    // that should ignore pre-existing content (secrets) iterate `addedSet`.
    const map = computeReviewableLines([
      {
        content: '@@ -1,3 +1,4 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        changes: [
          { type: 'normal', ln1: 1, ln2: 1, normal: true, content: ' a' },
          { type: 'add', add: true, ln: 2, content: '+b' },
          { type: 'normal', ln1: 2, ln2: 3, normal: true, content: ' c' },
          { type: 'add', add: true, ln: 4, content: '+d' },
        ],
      },
    ]);
    expect(map.set).toEqual(new Set([1, 2, 3, 4]));
    expect(map.addedSet).toEqual(new Set([2, 4]));
  });

  it('excludes deleted lines (they are LEFT side only)', () => {
    const map = computeReviewableLines([
      {
        content: '@@ -1,3 +1,2 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 2,
        changes: [
          { type: 'normal', ln1: 1, ln2: 1, normal: true, content: ' keep' },
          { type: 'del', del: true, ln: 2, content: '-removed' },
          { type: 'normal', ln1: 3, ln2: 2, normal: true, content: ' keep2' },
        ],
      },
    ]);
    expect(map.set).toEqual(new Set([1, 2]));
    expect(map.text.get(2)).toBe('keep2');
  });

  it('handles multiple chunks correctly', () => {
    const map = computeReviewableLines([
      {
        content: '@@ -1,2 +1,2 @@',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        changes: [
          { type: 'normal', ln1: 1, ln2: 1, normal: true, content: ' a' },
          { type: 'add', add: true, ln: 2, content: '+b' },
        ],
      },
      {
        content: '@@ -10,1 +10,2 @@',
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
        changes: [
          { type: 'normal', ln1: 10, ln2: 10, normal: true, content: ' x' },
          { type: 'add', add: true, ln: 11, content: '+y' },
        ],
      },
    ]);
    expect(map.ranges).toEqual([
      [1, 2],
      [10, 11],
    ]);
  });

  it('strips +/- /space diff markers from content text', () => {
    const map = computeReviewableLines([
      {
        content: '',
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        changes: [{ type: 'add', add: true, ln: 1, content: '+const x = 1;' }],
      },
    ]);
    expect(map.text.get(1)).toBe('const x = 1;');
  });
});
