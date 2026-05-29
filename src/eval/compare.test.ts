import { describe, expect, it } from 'vitest';
import type { Category, Severity } from '../types.js';
import { buildHunkIndex, compare } from './compare.js';
import type { NormalizedFinding } from './finding.js';

function f(
  source: 'ours' | 'codex',
  file_path: string,
  line: number,
  severity: Severity | 'unknown' = 'important',
  category: Category | 'unknown' = 'bug',
): NormalizedFinding {
  return { source, file_path, line, severity, category, body: 'b', raw: { source, line } };
}

const DIFF_TWO_HUNKS = `diff --git a/src/foo.ts b/src/foo.ts
index 1..2 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 a
 b
+x
+y
 c
@@ -50,3 +52,4 @@
 d
+z
 e
 f
`;

describe('buildHunkIndex', () => {
  it('extracts hunk ranges per file', () => {
    const idx = buildHunkIndex(DIFF_TWO_HUNKS);
    const hunks = idx.get('src/foo.ts');
    expect(hunks).toBeDefined();
    expect(hunks).toHaveLength(2);
    expect(hunks![0]).toEqual({ start: 10, end: 14, index: 0 });
    expect(hunks![1]).toEqual({ start: 52, end: 55, index: 1 });
  });

  it('returns an empty index for empty diff', () => {
    expect(buildHunkIndex('').size).toBe(0);
  });
});

describe('compare', () => {
  it('matches on hunk_id when both findings land in the same hunk', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 12)],
      codex: [f('codex', 'src/foo.ts', 14)],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.matchedBy).toBe('hunk');
    expect(r.totals.matched).toBe(1);
    expect(r.totals.agreement_rate).toBe(1);
  });

  it('falls back to line tolerance when hunks differ but lines are close', () => {
    // Two findings outside the diff (no hunk_id), within ±3 lines
    const r = compare({
      ours: [f('ours', 'src/bar.ts', 100)],
      codex: [f('codex', 'src/bar.ts', 102)],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.matchedBy).toBe('line');
    expect(r.matched[0]!.lineDistance).toBe(2);
  });

  it('does NOT match when lines are outside tolerance and hunks differ', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 12)],
      codex: [f('codex', 'src/foo.ts', 53)], // hunk_1 vs hunk_0 (ours)
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(0);
    expect(r.ours_only).toHaveLength(1);
    expect(r.codex_only).toHaveLength(1);
  });

  it('does NOT match same-hunk findings that are too far apart', () => {
    const diff = `diff --git a/src/big.ts b/src/big.ts
index 1..2 100644
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,120 +1,120 @@
 a
+b
 c
 d
 e
 f
 g
 h
 i
 j
 k
 l
 m
 n
 o
 p
 q
 r
 s
 t
 u
 v
 w
 x
 y
 z
 a2
 b2
 c2
 d2
 e2
 f2
 g2
 h2
 i2
 j2
 k2
 l2
 m2
 n2
 o2
 p2
 q2
 r2
 s2
 t2
 u2
 v2
 w2
 x2
 y2
 z2
 a3
 b3
 c3
 d3
 e3
 f3
 g3
 h3
 i3
 j3
 k3
 l3
 m3
 n3
 o3
 p3
 q3
 r3
 s3
 t3
 u3
 v3
 w3
 x3
 y3
 z3
 a4
 b4
 c4
 d4
 e4
 f4
 g4
 h4
 i4
 j4
 k4
 l4
 m4
 n4
 o4
 p4
 q4
 r4
 s4
 t4
 u4
 v4
 w4
 x4
 y4
 z4
 a5
 b5
 c5
 d5
 e5
 f5
 g5
 h5
 i5
 j5
 k5
 l5
 m5
 n5
 o5
 p5
 q5
 r5
 s5
 t5
 u5
 v5
 w5
 x5
 y5
 z5
`;
    const r = compare({
      ours: [f('ours', 'src/big.ts', 2)],
      codex: [f('codex', 'src/big.ts', 100)],
      diff,
    });
    expect(r.matched).toHaveLength(0);
    expect(r.ours_only).toHaveLength(1);
    expect(r.codex_only).toHaveLength(1);
  });

  it('allows callers to tune same-hunk line distance', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 12)],
      codex: [f('codex', 'src/foo.ts', 14)],
      diff: DIFF_TWO_HUNKS,
      lineTolerance: 1,
      hunkLineTolerance: 1,
    });
    expect(r.matched).toHaveLength(0);
  });

  it('does not match across different file paths', () => {
    const r = compare({
      ours: [f('ours', 'src/a.ts', 10)],
      codex: [f('codex', 'src/b.ts', 10)],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(0);
  });

  it('greedy nearest-match: closest Ours wins, others go to our_only', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 11), f('ours', 'src/foo.ts', 14)],
      codex: [f('codex', 'src/foo.ts', 13)],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.ours.line).toBe(14); // 14 is dist=1 vs 11 (dist=2)
    expect(r.ours_only).toHaveLength(1);
    expect(r.ours_only[0]!.line).toBe(11);
  });

  it('respects lineTolerance override', () => {
    const r = compare({
      ours: [f('ours', 'src/x.ts', 100)],
      codex: [f('codex', 'src/x.ts', 110)],
      diff: '',
      lineTolerance: 15,
    });
    expect(r.matched).toHaveLength(1);
  });

  it('computes severity_deltas histogram for matched pairs', () => {
    const r = compare({
      ours: [
        f('ours', 'src/foo.ts', 12, 'minor'), // hunk 0
        f('ours', 'src/foo.ts', 53, 'important'), // hunk 1
      ],
      codex: [
        f('codex', 'src/foo.ts', 12, 'critical'), // delta = +2 vs minor
        f('codex', 'src/foo.ts', 53, 'important'), // delta = 0
      ],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.matched).toHaveLength(2);
    expect(r.severity_deltas['+2']).toBe(1);
    expect(r.severity_deltas['0']).toBe(1);
  });

  it('bucket unknown severities into "unknown" delta', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 12, 'critical')],
      codex: [f('codex', 'src/foo.ts', 12, 'unknown')],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.severity_deltas['unknown']).toBe(1);
  });

  it('tallies category co-occurrence sorted by count', () => {
    const r = compare({
      ours: [
        f('ours', 'src/foo.ts', 12, 'important', 'bug'),
        f('ours', 'src/foo.ts', 53, 'important', 'bug'),
      ],
      codex: [
        f('codex', 'src/foo.ts', 12, 'important', 'security'),
        f('codex', 'src/foo.ts', 53, 'important', 'security'),
      ],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.category_co_occurrence[0]).toEqual({ ours: 'bug', codex: 'security', count: 2 });
  });

  it('reports agreement_rate as matched / max(ours, codex)', () => {
    const r = compare({
      ours: [f('ours', 'src/foo.ts', 12), f('ours', 'src/foo.ts', 13)],
      codex: [f('codex', 'src/foo.ts', 12), f('codex', 'src/foo.ts', 14)],
      diff: DIFF_TWO_HUNKS,
    });
    expect(r.totals.matched).toBe(2);
    expect(r.totals.agreement_rate).toBe(1);
  });

  it('agreement_rate is 0 with no matches but non-empty inputs', () => {
    const r = compare({
      ours: [f('ours', 'src/a.ts', 10)],
      codex: [f('codex', 'src/b.ts', 10)],
      diff: '',
    });
    expect(r.totals.agreement_rate).toBe(0);
  });

  it('agreement_rate is 1 when both sides are empty', () => {
    const r = compare({ ours: [], codex: [], diff: '' });
    expect(r.totals.agreement_rate).toBe(1);
  });
});
