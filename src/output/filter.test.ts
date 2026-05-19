import { describe, expect, it } from 'vitest';
import type { PostedComment, Severity } from '../types.js';
import { filterComments } from './filter.js';

const mk = (file: string, line: number, severity: Severity): PostedComment => ({
  severity,
  file_path: file,
  line,
  side: 'RIGHT',
  category: 'bug',
  title: `t-${file}-${line}`,
  why_it_matters: 'reason',
  confidence: 'high',
});

describe('filterComments', () => {
  it('keeps all comments when within limits', () => {
    const cs = [mk('a.ts', 1, 'critical'), mk('a.ts', 2, 'minor')];
    const r = filterComments(cs, {
      severityFloor: 'nit',
      maxCommentsPerFile: 5,
      maxCommentsTotal: 30,
    });
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toBe(0);
  });

  it('drops comments below severity floor', () => {
    const cs = [mk('a.ts', 1, 'critical'), mk('a.ts', 2, 'nit')];
    const r = filterComments(cs, {
      severityFloor: 'minor',
      maxCommentsPerFile: 10,
      maxCommentsTotal: 30,
    });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.severity).toBe('critical');
    expect(r.dropped).toBe(1);
  });

  it('enforces per-file cap keeping highest-severity first', () => {
    const cs = [
      mk('a.ts', 1, 'minor'),
      mk('a.ts', 2, 'critical'),
      mk('a.ts', 3, 'nit'),
      mk('a.ts', 4, 'important'),
    ];
    const r = filterComments(cs, {
      severityFloor: 'nit',
      maxCommentsPerFile: 2,
      maxCommentsTotal: 30,
    });
    expect(r.kept).toHaveLength(2);
    expect(r.kept.map((c) => c.severity).sort()).toEqual(['critical', 'important']);
    expect(r.dropped).toBe(2);
  });

  it('enforces global cap keeping highest-severity first', () => {
    const cs = [
      mk('a.ts', 1, 'minor'),
      mk('b.ts', 1, 'critical'),
      mk('c.ts', 1, 'nit'),
      mk('d.ts', 1, 'important'),
    ];
    const r = filterComments(cs, {
      severityFloor: 'nit',
      maxCommentsPerFile: 10,
      maxCommentsTotal: 2,
    });
    expect(r.kept).toHaveLength(2);
    expect(r.kept.map((c) => c.severity).sort()).toEqual(['critical', 'important']);
  });

  it('drops nothing when empty input', () => {
    const r = filterComments([], {
      severityFloor: 'nit',
      maxCommentsPerFile: 5,
      maxCommentsTotal: 30,
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(0);
  });

  it('per-file cap is independent across files', () => {
    const cs = [
      mk('a.ts', 1, 'minor'),
      mk('a.ts', 2, 'minor'),
      mk('a.ts', 3, 'minor'),
      mk('b.ts', 1, 'minor'),
      mk('b.ts', 2, 'minor'),
    ];
    const r = filterComments(cs, {
      severityFloor: 'nit',
      maxCommentsPerFile: 2,
      maxCommentsTotal: 30,
    });
    expect(r.kept).toHaveLength(4); // 2 from a + 2 from b
  });
});
