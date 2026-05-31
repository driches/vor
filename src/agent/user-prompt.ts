/**
 * Minimal "starter pistol" user prompt. All discipline lives in the system prompt.
 *
 * When `experimental.scanner_findings_in_user_prompt: true` is set, deterministic
 * scanner findings get injected as a structured block before the procedural
 * directives. The block tells Sonnet what's already covered so it can skip
 * redundant investigation and focus turns on semantic concerns.
 */

import type { ScanFinding } from '../scanners/types.js';

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
