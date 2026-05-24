/**
 * Renders a ReviewDraft into the Markdown body for the summary review.
 * Inline comment bodies are rendered separately in github/review-poster.ts.
 */

import type { RunAgentResult } from '../agent/runner.js';
import type { PostedComment, ReviewDraft, ReviewEvent, Severity } from '../types.js';

export interface SummaryRenderInput {
  draft: ReviewDraft;
  keptComments: readonly PostedComment[];
  truncatedCount: number;
  configEvent: ReviewEvent;
  modelName: string;
  /**
   * How the agent run terminated. When the run ended in anything other than
   * `summary_posted`, we surface that in the body so PR readers don't mistake
   * a truncated run for a clean review. Optional for backwards compatibility
   * with tests; orchestrator always supplies it.
   */
  agentEnded?: RunAgentResult['ended'];
}

export interface RenderedSummary {
  body: string;
  event: ReviewEvent;
}

/**
 * Builds the markdown body that becomes the review-level summary, and decides
 * the final ReviewEvent (APPROVE/REQUEST_CHANGES/COMMENT).
 *
 * The body header is the highest severity of the inline comments posted —
 * NOT the agent's assessment. Using "Approve" in a body posted as a COMMENT
 * event is misleading (the review isn't actually approving anything). The
 * severity label tells the reader at a glance what was found.
 *
 * The agent's `assessment` still drives the GitHub event when the repo opts
 * into APPROVE / REQUEST_CHANGES via `.code-review.yml`; the configured event
 * is the ceiling and the agent cannot escalate above it.
 */
export function renderSummary(input: SummaryRenderInput): RenderedSummary {
  const summary = input.draft.summary;
  const sections: string[] = [];

  // Headline: severity of the highest-severity finding (or "No findings").
  // Always rendered, even without an agent-supplied summary, so the body has a
  // real lede instead of an apologetic placeholder.
  sections.push(`### ${severityHeader(input.keptComments)}`);

  // When the agent didn't post a summary, surface that prominently — otherwise
  // a truncated run with zero findings looks indistinguishable from a clean
  // "No findings" review. The blockquote sits between the lede and any
  // findings/strengths so a PR reader can't miss it.
  if (!summary) {
    sections.push(missingSummaryWarning(input.agentEnded));
  }

  if (summary) {
    sections.push(summary.assessment_reasoning);
  }

  // Strengths (only available from the agent's summary)
  if (summary && summary.strengths.length > 0) {
    sections.push('### Strengths');
    sections.push(summary.strengths.map((s) => `- ${s}`).join('\n'));
  }

  // Findings summary by severity (detail under the header)
  if (input.keptComments.length > 0) {
    const counts = countBySeverity(input.keptComments);
    sections.push('### Findings');
    sections.push(formatCountsLine(counts));
  }

  // Coverage notes (only available from the agent's summary)
  if (summary?.coverage_note) {
    sections.push('### Coverage');
    sections.push(summary.coverage_note);
  }
  if (summary?.unreviewed_paths && summary.unreviewed_paths.length > 0) {
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
  // No summary → no assessment → default to COMMENT.
  const agentEvent: ReviewEvent = !summary
    ? 'COMMENT'
    : summary.assessment === 'approve'
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

/**
 * Warning emitted when the agent finished without calling `post_summary`.
 * Names the `ended` reason when known so a reader can tell turn-limit from
 * budget-blowup from an error abort.
 */
function missingSummaryWarning(ended: RunAgentResult['ended'] | undefined): string {
  const reasons: Record<RunAgentResult['ended'], string> = {
    summary_posted: '', // Unreachable: we only call this when summary is missing.
    max_turns: 'the agent hit the turn limit before finishing',
    budget_exceeded: 'the agent exhausted its token budget before finishing',
    aborted: 'the agent run was aborted',
    error: 'the agent run errored out',
  };
  const tail =
    ended && ended !== 'summary_posted'
      ? ` — ${reasons[ended]} (\`ended: ${ended}\`).`
      : '.';
  return (
    `> ⚠️ The agent did not call \`post_summary\`${tail} ` +
    `The body was synthesized from inline findings and may be incomplete.`
  );
}

/**
 * Body header label, derived from the highest-severity inline comment posted.
 *
 * Rationale: the review event is almost always COMMENT (we don't gate merges
 * by default), so saying "Approve" in the body is misleading. The severity
 * label gives the reader a quick at-a-glance signal of what was found.
 */
function severityHeader(comments: readonly PostedComment[]): string {
  if (comments.length === 0) return 'No findings';
  if (comments.some((c) => c.severity === 'critical')) return 'Critical findings';
  if (comments.some((c) => c.severity === 'important')) return 'Important findings';
  if (comments.some((c) => c.severity === 'minor')) return 'Minor findings';
  return 'Notes only';
}
