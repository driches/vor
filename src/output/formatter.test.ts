import { describe, expect, it } from 'vitest';
import type { PostedComment, ReviewDraft, SummaryInput } from '../types.js';
import { renderSummary } from './formatter.js';

const baseSummary = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  strengths: ['Clear naming.', 'Tests cover the happy path.'],
  assessment: 'comment',
  assessment_reasoning: 'Solid change with one significant concern.',
  ...over,
});

const baseDraft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({
  comments: [],
  skipped: [],
  summary: baseSummary(),
  ...over,
});

const c = (severity: PostedComment['severity']): PostedComment => ({
  severity,
  file_path: 'a.ts',
  line: 1,
  side: 'RIGHT',
  category: 'bug',
  title: 't',
  why_it_matters: 'why',
  confidence: 'high',
});

describe('renderSummary — severity header', () => {
  it('shows "Critical findings" when at least one critical comment is posted', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('critical'), c('important'), c('minor')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'claude-sonnet-4-6',
    });
    expect(r.body).toContain('### Critical findings');
  });

  it('shows "Important findings" when highest severity is important', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('important'), c('minor'), c('nit')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('### Important findings');
    expect(r.body).not.toContain('### Critical');
  });

  it('shows "Minor findings" when highest severity is minor', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('minor'), c('nit')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('### Minor findings');
  });

  it('shows "Notes only" when only nits are posted', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('nit'), c('nit')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('### Notes only');
  });

  it('shows "No findings" when no comments were posted', () => {
    const r = renderSummary({
      draft: baseDraft({ summary: baseSummary({ assessment: 'approve' }) }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('### No findings');
  });

  it('never uses the literal assessment words (Approve / Request changes / Comment) as a section header', () => {
    const r = renderSummary({
      draft: baseDraft({ summary: baseSummary({ assessment: 'approve' }) }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).not.toContain('### Approve');
    expect(r.body).not.toContain('### Request changes');
    expect(r.body).not.toContain('### Comment');
  });
});

describe('renderSummary — body content', () => {
  it('emits strengths and finding counts', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('critical'), c('important'), c('minor')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'claude-sonnet-4-6',
    });
    expect(r.body).toContain('Strengths');
    expect(r.body).toContain('Clear naming');
    expect(r.body).toContain('Findings');
    expect(r.body).toContain('1 critical, 1 important, 1 minor');
    expect(r.body).toContain('claude-sonnet-4-6');
  });

  it('mentions truncated comments', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('minor')],
      truncatedCount: 7,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('7 additional comment');
  });

  it('emits coverage_note when present', () => {
    const r = renderSummary({
      draft: baseDraft({
        summary: baseSummary({ coverage_note: 'Skipped generated protobuf files.' }),
      }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('Coverage');
    expect(r.body).toContain('Skipped generated protobuf');
  });

  it('lists unreviewed_paths', () => {
    const r = renderSummary({
      draft: baseDraft({
        summary: baseSummary({ unreviewed_paths: ['a.ts', 'b.ts', 'c.ts'] }),
      }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('Skipped');
    expect(r.body).toContain('a.ts, b.ts, c.ts');
  });

  it('handles missing summary gracefully', () => {
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('no summary');
  });

  it('emits a Security sub-line when scanner-sourced comments are kept', () => {
    const scannerComment: PostedComment = {
      ...c('important'),
      category: 'vulnerability',
      source: { kind: 'scanner', scanner: 'dependency-cve', cve_id: 'CVE-2024-0001' },
    };
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('critical'), scannerComment],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('Security:');
    expect(r.body).toContain('dependency CVE');
  });

  it('omits the Security sub-line when no scanner-sourced comments are kept', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('critical'), c('important')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).not.toContain('Security:');
  });
});

describe('renderSummary — event selection (unchanged)', () => {
  it('returns APPROVE event when agent approves and config allows', () => {
    const r = renderSummary({
      draft: baseDraft({ summary: baseSummary({ assessment: 'approve' }) }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'APPROVE',
      modelName: 'm',
    });
    expect(r.event).toBe('APPROVE');
  });

  it('downgrades agent APPROVE to COMMENT when config ceiling is COMMENT', () => {
    const r = renderSummary({
      draft: baseDraft({ summary: baseSummary({ assessment: 'approve' }) }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.event).toBe('COMMENT');
  });

  it('downgrades agent REQUEST_CHANGES to COMMENT when config ceiling is COMMENT', () => {
    const r = renderSummary({
      draft: baseDraft({
        summary: baseSummary({ assessment: 'request_changes' }),
      }),
      keptComments: [c('critical')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.event).toBe('COMMENT');
  });

  it('emits REQUEST_CHANGES when config ceiling permits', () => {
    const r = renderSummary({
      draft: baseDraft({
        summary: baseSummary({ assessment: 'request_changes' }),
      }),
      keptComments: [c('critical')],
      truncatedCount: 0,
      configEvent: 'REQUEST_CHANGES',
      modelName: 'm',
    });
    expect(r.event).toBe('REQUEST_CHANGES');
  });
});
