import { describe, expect, it } from 'vitest';
import type { PostedComment, SkippedFile, SummaryInput } from '../types.js';
import { ReviewAggregator } from './aggregator.js';

const c = (over: Partial<PostedComment> = {}): PostedComment => ({
  severity: 'minor',
  file_path: 'a.ts',
  line: 1,
  side: 'RIGHT',
  category: 'readability',
  title: 't',
  why_it_matters: 'why',
  confidence: 'high',
  ...over,
});

const s = (assessment: SummaryInput['assessment'] = 'comment'): SummaryInput => ({
  strengths: ['good test coverage'],
  assessment,
  assessment_reasoning: 'looks fine',
});

describe('ReviewAggregator', () => {
  it('starts empty', () => {
    const a = new ReviewAggregator();
    expect(a.acceptedComments).toEqual([]);
    expect(a.hasSummary()).toBe(false);
    expect(a.hasCriticalOrImportant()).toBe(false);
  });

  it('stores comments and skipped files', () => {
    const a = new ReviewAggregator();
    a.addComment(c());
    a.addComment(c({ line: 2 }));
    a.addSkipped({ file_path: 'lock.lock', reason: 'lockfile' } as SkippedFile);
    expect(a.acceptedComments).toHaveLength(2);
    expect(a.snapshot().skipped).toHaveLength(1);
  });

  it('throws if summary set twice', () => {
    const a = new ReviewAggregator();
    a.setSummary(s());
    expect(() => a.setSummary(s())).toThrow(/only be called once/);
  });

  it('hasCriticalOrImportant returns true if any critical', () => {
    const a = new ReviewAggregator();
    a.addComment(c({ severity: 'minor' }));
    a.addComment(c({ severity: 'critical' }));
    expect(a.hasCriticalOrImportant()).toBe(true);
  });

  it('hasCriticalOrImportant returns false for minor/nit only', () => {
    const a = new ReviewAggregator();
    a.addComment(c({ severity: 'minor' }));
    a.addComment(c({ severity: 'nit' }));
    expect(a.hasCriticalOrImportant()).toBe(false);
  });

  it('snapshot includes summary if set', () => {
    const a = new ReviewAggregator();
    a.setSummary(s('approve'));
    expect(a.snapshot().summary).toBeDefined();
    expect(a.snapshot().summary!.assessment).toBe('approve');
  });
});
