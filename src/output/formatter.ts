/**
 * Renders a ReviewDraft into the Markdown body for the summary review.
 * Inline comment bodies are rendered separately in github/review-poster.ts.
 */

import type { RunAgentResult } from '../agent/runner.js';
import type { PostedComment, ReviewDraft, ReviewEvent, ScannerId, Severity } from '../types.js';

export interface SummaryRenderInput {
  draft: ReviewDraft;
  keptComments: readonly PostedComment[];
  truncatedCount: number;
  configEvent: ReviewEvent;
  modelName: string;
  /** Paths removed from the LLM's review scope by deterministic budget gates. */
  unreviewedPaths?: readonly string[];
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
  const unreviewedPaths = mergeUniquePaths(
    summary?.unreviewed_paths ?? [],
    input.unreviewedPaths ?? [],
  );
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
    const scannerLine = formatScannerCountsLine(input.keptComments);
    if (scannerLine) sections.push(scannerLine);
  } else if (summary && summary.assessment !== 'approve') {
    // When summary is missing we already emit the prominent missing-summary
    // warning above; don't pile on with a redundant "no inline comments" note.
    sections.push('_No inline comments were posted._');
  }

  // Coverage notes (only available from the agent's summary)
  if (summary?.coverage_note) {
    sections.push('### Coverage');
    sections.push(summary.coverage_note);
  }
  if (unreviewedPaths.length > 0) {
    sections.push(
      `_Skipped (out of budget):_ ${unreviewedPaths.slice(0, 20).join(', ')}` +
        (unreviewedPaths.length > 20
          ? ` _+${unreviewedPaths.length - 20} more_`
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

function mergeUniquePaths(
  a: readonly string[],
  b: readonly string[],
): string[] {
  return [...new Set([...a, ...b])];
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
 * Names the `ended` reason when known so a reader can tell a model that
 * stopped early from a budget blowup from an error abort.
 *
 * Wording note: the `ended` values in `RunAgentResult` are slightly misleading
 * by name — the runner sets `max_turns` when the model returns `end_turn`
 * (or stops emitting tool_use blocks) without posting a summary, NOT when the
 * configured turn cap is hit. Real turn-cap exhaustion is thrown as a
 * `BudgetError` from `Budget.startTurn` and surfaces as `budget_exceeded`
 * (alongside actual token-cap exhaustion). The phrasing here reflects what
 * actually happened, not what the enum name suggests. See runner.ts:151-153
 * and budget.ts:30-52 — renaming the enum is a follow-up.
 */
function missingSummaryWarning(ended: RunAgentResult['ended'] | undefined): string {
  const reasons: Record<RunAgentResult['ended'], string> = {
    summary_posted: '', // Unreachable: we only call this when summary is missing.
    max_turns: 'the model stopped replying before calling `post_summary`',
    output_truncated:
      'the response hit the per-request output token cap mid-stream (consider raising `budget.max_output_tokens`)',
    budget_exceeded: 'the run exceeded a configured budget (turns or tokens)',
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

/**
 * Returns a "Security:" sub-line summarizing how many of the kept comments
 * came from scanners, broken down by scanner id. Returns `null` when no
 * scanner-sourced comments are present so the line is suppressed.
 */
function formatScannerCountsLine(comments: readonly PostedComment[]): string | null {
  const byScanner = new Map<ScannerId, number>();
  for (const c of comments) {
    if (c.source?.kind !== 'scanner') continue;
    byScanner.set(c.source.scanner, (byScanner.get(c.source.scanner) ?? 0) + 1);
  }
  const total = Array.from(byScanner.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const labels: Array<[ScannerId, string, string]> = [
    ['dependency-cve', 'dependency CVE', 'dependency CVEs'],
    ['secrets', 'secret', 'secrets'],
    ['sast', 'SAST', 'SAST'],
    ['container-cve', 'container CVE', 'container CVEs'],
    ['coverage-delta', 'coverage gap', 'coverage gaps'],
  ];
  const breakdown = labels
    .map(([id, singular, plural]) => {
      const n = byScanner.get(id) ?? 0;
      if (n === 0) return null;
      return `${n} ${n === 1 ? singular : plural}`;
    })
    .filter((s): s is string => s !== null)
    .join(', ');

  const noun = total === 1 ? 'finding' : 'findings';
  return `**Security:** ${total} ${noun} from scanners (${breakdown})`;
}
