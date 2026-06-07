import { describe, expect, it } from 'vitest';
import type { PostedComment, ReviewDraft, SummaryInput } from '../types.js';
import type { ScanFinding } from '../scanners/types.js';
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

  it('merges orchestrator-scoped unreviewed paths with summary paths', () => {
    const r = renderSummary({
      draft: baseDraft({
        summary: baseSummary({ unreviewed_paths: ['a.ts'] }),
      }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      unreviewedPaths: ['a.ts', 'dist/bundle.js'],
    });
    expect(r.body).toContain('a.ts, dist/bundle.js');
  });

  it('synthesizes a body from comments when the agent skipped post_summary', () => {
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [c('important'), c('minor')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'claude-sonnet-4-6',
      agentEnded: 'max_turns',
    });
    // No apologetic standalone-body placeholder.
    expect(r.body).not.toMatch(/^_Code review completed by/);
    // Real lede + findings count derived from inline comments.
    expect(r.body).toContain('### Important findings');
    expect(r.body).toContain('### Findings');
    expect(r.body).toContain('1 important, 1 minor');
    // The incomplete-run warning is present and names the ended reason.
    // NB: `max_turns` in the runner actually means "model stopped early",
    // not "turn-cap hit" (real cap exhaustion → budget_exceeded), so the
    // wording must reflect what happened, not the enum name.
    expect(r.body).toContain('did not call `post_summary`');
    expect(r.body).toContain('model stopped replying');
    expect(r.body).toContain('ended: max_turns');
    expect(r.body).not.toContain('turn limit');
    // Footer still attaches.
    expect(r.body).toContain('claude-sonnet-4-6');
    // No assessment → COMMENT.
    expect(r.event).toBe('COMMENT');
  });

  it('warns prominently even when there are zero findings + no summary (avoids false-negative clean reviews)', () => {
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      agentEnded: 'budget_exceeded',
    });
    expect(r.event).toBe('COMMENT');
    // Header still reflects the (empty) inline findings honestly...
    expect(r.body).toContain('### No findings');
    // ...but the warning sits right after it so a PR reader can't mistake
    // a truncated run for a clean review.
    const headerIdx = r.body.indexOf('### No findings');
    const warningIdx = r.body.indexOf('did not call `post_summary`');
    expect(warningIdx).toBeGreaterThan(headerIdx);
    // `budget_exceeded` covers both turn-cap and token-cap exhaustion, so
    // the wording must not commit to one over the other.
    expect(r.body).toContain('exceeded a configured budget');
    expect(r.body).toContain('ended: budget_exceeded');
    // No strengths/coverage sections sneak in.
    expect(r.body).not.toContain('### Strengths');
    expect(r.body).not.toContain('### Coverage');
  });

  it('still surfaces the truncated-comments line when summary is missing', () => {
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [c('minor')],
      truncatedCount: 3,
      configEvent: 'COMMENT',
      modelName: 'm',
      agentEnded: 'error',
    });
    expect(r.body).toContain('3 additional comment');
    expect(r.body).toContain('errored out');
  });

  it('falls back to a generic warning when agentEnded is not supplied', () => {
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).toContain('did not call `post_summary`');
    // No `ended:` annotation when we don't know how it ended.
    expect(r.body).not.toContain('ended:');
  });

  it('does NOT emit the missing-summary warning when summary IS present', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('minor')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      agentEnded: 'summary_posted',
    });
    expect(r.body).not.toContain('did not call `post_summary`');
  });

  it('clamps to COMMENT when no summary is present, even when configEvent ceiling is REQUEST_CHANGES', () => {
    // The point of the no-summary → COMMENT default: without an agent
    // assessment, we cannot justify escalating the review event, regardless of
    // what the repo config would otherwise permit.
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [c('critical')],
      truncatedCount: 0,
      configEvent: 'REQUEST_CHANGES',
      modelName: 'm',
    });
    expect(r.event).toBe('COMMENT');
  });

  it('clamps to COMMENT when no summary is present, even when configEvent ceiling is APPROVE', () => {
    // APPROVE has a different rank than REQUEST_CHANGES in chooseEvent, so
    // it's a distinct code path through the clamp logic.
    const r = renderSummary({
      draft: { comments: [], skipped: [] },
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'APPROVE',
      modelName: 'm',
    });
    expect(r.event).toBe('COMMENT');
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

describe('renderSummary — binary-file findings (non-inline channel)', () => {
  const ocrFinding = (over: Partial<ScanFinding> = {}): ScanFinding => ({
    scanner: 'image-ocr',
    rule_id: 'aws-access-key-id',
    file_path: 'docs/login.png',
    line: 1,
    severity: 'critical',
    category: 'security',
    title: 'AWS access key in image',
    description: 'A live-looking AWS key was OCR’d out of a committed screenshot.',
    confidence: 'high',
    evidence: {
      kind: 'ocr',
      masked_match: 'AKIA…WXYZ',
      pattern_id: 'aws-access-key-id',
      ocr_confidence: 92.4,
    },
    fingerprint: 'aws-access-key-id:docs/login.png',
    ...over,
  });

  it('renders a dedicated section with masked match, pattern, and OCR confidence', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      binaryFindings: [ocrFinding()],
    });
    expect(r.body).toContain('### Security findings in binary files');
    expect(r.body).toContain('`docs/login.png`');
    expect(r.body).toContain('AWS access key in image');
    expect(r.body).toContain('pattern `aws-access-key-id`');
    expect(r.body).toContain('OCR confidence 92%');
    expect(r.body).toContain('masked match `AKIA…WXYZ`');
  });

  it('counts a binary finding toward the severity headline even with no inline comments', () => {
    const r = renderSummary({
      draft: baseDraft({ summary: undefined }),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      binaryFindings: [ocrFinding({ severity: 'critical' })],
    });
    expect(r.body).toContain('### Critical findings');
    expect(r.body).not.toContain('### No findings');
  });

  it('omits the section entirely when there are no binary findings', () => {
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [c('minor')],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
    });
    expect(r.body).not.toContain('Security findings in binary files');
  });

  it('caps the list and appends a "+N more" tail', () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      ocrFinding({ file_path: `img/${i}.png`, fingerprint: `k:${i}` }),
    );
    const r = renderSummary({
      draft: baseDraft(),
      keptComments: [],
      truncatedCount: 0,
      configEvent: 'COMMENT',
      modelName: 'm',
      binaryFindings: many,
    });
    expect(r.body).toContain('_+3 more_');
  });
});
