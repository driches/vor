/**
 * Renders a ReviewDraft into the Markdown body for the summary review.
 * Inline comment bodies are rendered separately in github/review-poster.ts.
 */

import type { PostedComment, ReviewDraft, ReviewEvent, Severity } from '../types.js';

export interface SummaryRenderInput {
  draft: ReviewDraft;
  keptComments: readonly PostedComment[];
  truncatedCount: number;
  configEvent: ReviewEvent;
  modelName: string;
}

export interface RenderedSummary {
  body: string;
  event: ReviewEvent;
}

const ASSESSMENT_LABEL: Record<NonNullable<ReviewDraft['summary']>['assessment'], string> = {
  approve: 'Approve',
  request_changes: 'Request changes',
  comment: 'Comment',
};

/**
 * Builds the markdown body that becomes the review-level summary, and decides
 * the final ReviewEvent (APPROVE/REQUEST_CHANGES/COMMENT).
 *
 * The configured `event` from .code-review.yml is the ceiling — the agent
 * cannot escalate above what the repo opts into. With the default `COMMENT`
 * config, all reviews are non-blocking regardless of the agent's assessment.
 */
export function renderSummary(input: SummaryRenderInput): RenderedSummary {
  const summary = input.draft.summary;
  if (!summary) {
    return {
      body: `_Code review completed by [driches/code-review](https://github.com/driches/code-review) (${input.modelName}) but no summary was produced._`,
      event: 'COMMENT',
    };
  }

  const sections: string[] = [];

  // Headline assessment
  sections.push(`### ${ASSESSMENT_LABEL[summary.assessment]}`);
  sections.push(summary.assessment_reasoning);

  // Strengths
  if (summary.strengths.length > 0) {
    sections.push('### Strengths');
    sections.push(summary.strengths.map((s) => `- ${s}`).join('\n'));
  }

  // Findings summary by severity
  const counts = countBySeverity(input.keptComments);
  if (input.keptComments.length > 0) {
    sections.push('### Findings');
    sections.push(formatCountsLine(counts));
  } else if (summary.assessment !== 'approve') {
    sections.push('_No inline comments were posted._');
  }

  // Coverage notes
  if (summary.coverage_note) {
    sections.push('### Coverage');
    sections.push(summary.coverage_note);
  }
  if (summary.unreviewed_paths && summary.unreviewed_paths.length > 0) {
    sections.push(
      `_Skipped (out of budget):_ ${summary.unreviewed_paths.slice(0, 20).join(', ')}` +
        (summary.unreviewed_paths.length > 20
          ? ` _+${summary.unreviewed_paths.length - 20} more_`
          : ''),
    );
  }
  if (input.truncatedCount > 0) {
    sections.push(
      `_${input.truncatedCount} additional comment(s) were dropped due to per-file or global caps._`,
    );
  }

  sections.push('---');
  sections.push(
    `_Reviewed by [driches/code-review](https://github.com/driches/code-review) using \`${input.modelName}\`._`,
  );

  // Choose the final event: take the min of (agent assessment, configured ceiling).
  const agentEvent: ReviewEvent =
    summary.assessment === 'approve'
      ? 'APPROVE'
      : summary.assessment === 'request_changes'
        ? 'REQUEST_CHANGES'
        : 'COMMENT';
  const event = chooseEvent(input.configEvent, agentEvent);

  return { body: sections.join('\n\n'), event };
}

/** Take the less-aggressive of the two events. */
function chooseEvent(configCeiling: ReviewEvent, agentChoice: ReviewEvent): ReviewEvent {
  const rank: Record<ReviewEvent, number> = { COMMENT: 0, APPROVE: 1, REQUEST_CHANGES: 2 };
  return rank[agentChoice] <= rank[configCeiling] ? agentChoice : configCeiling;
}

function countBySeverity(comments: readonly PostedComment[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, important: 0, minor: 0, nit: 0 };
  for (const c of comments) out[c.severity] += 1;
  return out;
}

function formatCountsLine(counts: Record<Severity, number>): string {
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.important) parts.push(`${counts.important} important`);
  if (counts.minor) parts.push(`${counts.minor} minor`);
  if (counts.nit) parts.push(`${counts.nit} nit`);
  return parts.length ? parts.join(', ') : 'No findings.';
}
