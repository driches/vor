/**
 * Minimal "starter pistol" user prompt. All discipline lives in the system prompt.
 *
 * When `experimental.scanner_findings_in_user_prompt: true` is set, deterministic
 * scanner findings get injected as a structured block before the procedural
 * directives. The block tells Sonnet what's already covered so it can skip
 * redundant investigation and focus turns on semantic concerns.
 */

import type { ScanFinding } from '../scanners/types.js';
import type { PriorReviewThread } from '../github/prior-review-threads.js';

export function buildUserPrompt(input: {
  owner: string;
  repo: string;
  pull_number: number;
  scanner_findings?: ReadonlyArray<ScanFinding>;
  /**
   * Cap on the number of scanner findings rendered into the prompt. The
   * orchestrator passes `severity.max_comments_total` here — findings that
   * couldn't survive the post-filter cap can't legitimately be cited as
   * "already detected" anyway, and rendering them would bloat the agent's
   * first input (a coverage-delta run on a big PR can emit thousands).
   * When omitted, falls back to `MAX_INJECTED_FINDINGS_DEFAULT`.
   */
  max_scanner_findings?: number;
  /**
   * The agent's own prior review threads on this PR (findings it posted on an
   * earlier commit, plus author replies). Injected so the agent dedups against
   * itself and honors pushback instead of re-posting duplicate threads.
   */
  prior_threads?: ReadonlyArray<PriorReviewThread>;
  /** Cap on rendered prior threads. Defaults to MAX_INJECTED_PRIOR_THREADS_DEFAULT. */
  max_prior_threads?: number;
}): string {
  const parts: string[] = [
    `Review pull request #${input.pull_number} in ${input.owner}/${input.repo}.`,
    '',
  ];

  const findings = input.scanner_findings ?? [];
  if (findings.length > 0) {
    parts.push(
      renderScannerFindings(findings, input.max_scanner_findings ?? MAX_INJECTED_FINDINGS_DEFAULT),
    );
    parts.push('');
  }

  const priorThreads = input.prior_threads ?? [];
  if (priorThreads.length > 0) {
    parts.push(
      renderPriorReviewThreads(
        priorThreads,
        input.max_prior_threads ?? MAX_INJECTED_PRIOR_THREADS_DEFAULT,
      ),
    );
    parts.push('');
  }

  parts.push(
    'Start by calling get_pr_metadata, then read_repo_context_file, then list_changed_files.',
    'Work through the changes and post each finding via post_inline_comment. End with post_summary.',
  );
  return parts.join('\n');
}

/**
 * Fallback cap when no per-run budget is provided. 30 matches the default
 * `severity.max_comments_total` so flag-ON behavior is consistent end-to-end
 * even if a caller (test, alt entry-point) doesn't pass an explicit cap.
 */
const MAX_INJECTED_FINDINGS_DEFAULT = 30;

/**
 * Render deterministic scanner findings as a block the agent can scan in a
 * single glance. Severity-sorted (critical → important → minor → nit). Each
 * finding gets one line; long titles/descriptions are truncated.
 *
 * Framing rules (these reflect what we expect Sonnet to internalize):
 *   - "Already detected" — not "candidate". The findings are eligible to be
 *     posted independently of the agent's review, subject to final caps/dedup.
 *   - Explicit "do not re-flag" instruction. Without this, Sonnet often
 *     re-investigates and re-posts what scanners caught.
 *   - "Focus on what scanners can't catch" — names the semantic / design /
 *     architectural axes that need an LLM's judgment.
 *   - No suggested action per finding. The agent should NOT escalate or
 *     downgrade scanner severity decisions; those are deterministic-rule
 *     calls and re-litigating them in the LLM is the regression we're
 *     trying to avoid.
 *
 * Exported for unit tests so the framing language stays pinned.
 */
export function renderScannerFindings(
  findings: ReadonlyArray<ScanFinding>,
  maxFindings: number = MAX_INJECTED_FINDINGS_DEFAULT,
): string {
  const severityRank: Record<string, number> = {
    critical: 0,
    important: 1,
    minor: 2,
    nit: 3,
  };
  const sorted = [...findings].sort((a, b) => {
    const r = (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
    if (r !== 0) return r;
    if (a.file_path !== b.file_path) return a.file_path.localeCompare(b.file_path);
    return a.line - b.line;
  });

  // Cap before rendering so the prompt stays bounded regardless of scanner
  // output size. coverage-delta in particular can emit one finding per
  // uncovered added line — a 2000-line PR with low coverage could produce
  // thousands of entries. Severity-sorted, so the cap keeps the most
  // important ones. Codex P2 #3311267539 on PR #36.
  const capped = sorted.slice(0, Math.max(0, maxFindings));
  const truncated = sorted.length - capped.length;

  const lines: string[] = [];
  const header =
    truncated > 0
      ? `## Deterministic scanner findings (${capped.length} shown / ${findings.length} total) — already detected, scanner pipeline handles these`
      : `## Deterministic scanner findings (${findings.length}) — already detected, scanner pipeline handles these`;
  lines.push(
    header,
    '',
    'Scanners ran BEFORE you. The findings below are eligible to post through the scanner pipeline (subject to final caps/dedup) — you do NOT need to investigate, verify, or re-flag them. Treat them as covered unless you find a distinct semantic issue nearby.',
    '',
    "Your job is what scanners CAN'T catch: semantic correctness, design coherence, architectural fit, race conditions, doc-vs-code drift, and any subtle correctness bug that doesn't match a pattern. Spend your turns there.",
    '',
  );
  for (const f of capped) {
    const title = f.title.length > 120 ? `${f.title.slice(0, 117)}...` : f.title;
    lines.push(
      `- [${f.severity}] \`${f.file_path}:${f.line}\` — ${f.scanner}/${f.rule_id}: ${title}`,
    );
  }
  if (truncated > 0) {
    lines.push(
      '',
      `(${truncated} additional lower-severity scanner finding(s) omitted from this block — they'll still be posted by the scanner pipeline subject to the configured cap.)`,
    );
  }
  return lines.join('\n');
}

/**
 * Fallback cap for prior-thread injection. Threads are usually few, but a
 * long-lived PR with many pushes can accumulate them; cap so the prompt stays
 * bounded. Threads with author replies sort first, so the cap keeps the
 * highest-signal (pushed-back) ones.
 */
const MAX_INJECTED_PRIOR_THREADS_DEFAULT = 30;

/**
 * Per-thread reply cap. The thread cap alone doesn't bound prompt size: a
 * single contentious finding can accumulate a long reply chain. Keep the
 * earliest replies (the author's initial pushback is the highest-signal one)
 * and note how many were omitted.
 */
const MAX_REPLIES_PER_THREAD = 5;

/**
 * Render the agent's prior review threads as a block it can scan in one glance.
 * Threads carrying author replies sort first (pushback is the case the agent
 * most needs to honor), then by file/line for stable output.
 *
 * Framing rules:
 *   - "Do NOT re-post" — the threads are still open on the PR; re-raising the
 *     same finding creates a duplicate thread on the same line.
 *   - "Do NOT re-issue what the author rejected" — names the pushback phrases
 *     so the model recognizes them in the reply text rendered below.
 *   - "NOT areas to skip" — load-bearing anti-regression: the agent must still
 *     review the current changes fully, just not duplicate or re-litigate.
 *
 * Exported for unit tests so the framing language stays pinned.
 */
export function renderPriorReviewThreads(
  threads: ReadonlyArray<PriorReviewThread>,
  maxThreads: number = MAX_INJECTED_PRIOR_THREADS_DEFAULT,
): string {
  const sorted = [...threads].sort((a, b) => {
    const r = (b.replies.length > 0 ? 1 : 0) - (a.replies.length > 0 ? 1 : 0);
    if (r !== 0) return r;
    if (a.file_path !== b.file_path) return a.file_path.localeCompare(b.file_path);
    return (a.line ?? 0) - (b.line ?? 0);
  });
  const capped = sorted.slice(0, Math.max(0, maxThreads));
  const truncated = sorted.length - capped.length;

  const lines: string[] = [];
  lines.push(
    truncated > 0
      ? `## Your prior review threads on this PR (${capped.length} shown / ${threads.length} total)`
      : `## Your prior review threads on this PR (${threads.length})`,
    '',
    'You already reviewed an earlier version of this PR. The inline comments below are findings YOU posted, with any author replies. These threads are still open on the PR.',
    '',
    'RULES:',
    '- Do NOT re-post a finding that already appears here — it would create a duplicate thread on the same line. Raise it again only if the code at that location changed and the issue genuinely still applies, and say so.',
    '- If the author replied rejecting a finding ("won\'t fix", "wontfix", "by design", "intentional", "as documented", "disagree", or similar), DO NOT re-issue it. They already evaluated and rejected it; re-raising erodes trust.',
    '- These are NOT areas to skip. Review the current changes fully — just avoid duplicating or re-litigating what is below.',
    '',
  );
  for (const t of capped) {
    const loc = t.line == null ? t.file_path : `${t.file_path}:${t.line}`;
    const outdated = t.outdated ? ' (outdated — author pushed past this line)' : '';
    lines.push(`- \`${loc}\`${outdated} — ${t.finding_excerpt}`);
    // Cap replies PER THREAD, not just the thread count. A long back-and-forth
    // on one finding could otherwise inject hundreds of 200-char lines and trip
    // the input budget despite maxThreads. Keep the earliest replies — the
    // author's initial response is where pushback ("won't fix", "by design")
    // almost always lands. addressing #58 (Codex P2 review).
    const shownReplies = t.replies.slice(0, MAX_REPLIES_PER_THREAD);
    for (const reply of shownReplies) {
      lines.push(`    - reply from @${reply.author}: "${reply.excerpt}"`);
    }
    const omittedReplies = t.replies.length - shownReplies.length;
    if (omittedReplies > 0) {
      lines.push(
        `    - (+${omittedReplies} more repl${omittedReplies === 1 ? 'y' : 'ies'} in this thread, omitted)`,
      );
    }
  }
  if (truncated > 0) {
    lines.push('', `(${truncated} additional prior thread(s) omitted from this block.)`);
  }
  return lines.join('\n');
}
