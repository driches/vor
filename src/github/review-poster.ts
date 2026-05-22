/**
 * Posts the final review to GitHub in a single `pulls.createReview` call,
 * with all inline comments attached. Used by the orchestrator after the
 * agent has assembled a `ReviewDraft` and the output filter has trimmed it.
 */

import type { Octokit } from '@octokit/rest';
import type { PostedComment, ReviewEvent, Side } from '../types.js';
import { GitHubApiError } from '../util/errors.js';
import { AGENT_REVIEW_MARKER } from './prior-reviews.js';

export interface PostReviewInput {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: PostedComment[];
}

export interface PostReviewResult {
  review_id: number;
  comment_count: number;
}

interface OctokitInlineComment {
  path: string;
  line: number;
  side: Side;
  body: string;
  start_line?: number;
  start_side?: Side;
}

export async function postReview(
  octokit: Octokit,
  input: PostReviewInput,
): Promise<PostReviewResult> {
  const bodyWithMarker = `${AGENT_REVIEW_MARKER}\n\n${input.body}`;
  const inlineComments: OctokitInlineComment[] = input.comments.map((c) => ({
    path: c.file_path,
    line: c.line,
    side: c.side,
    body: renderCommentBody(c),
    ...(c.start_line !== undefined
      ? { start_line: c.start_line, start_side: c.side }
      : {}),
  }));

  try {
    const r = await octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pull_number,
      commit_id: input.commit_id,
      event: input.event,
      body: bodyWithMarker,
      comments: inlineComments,
    });
    return { review_id: r.data.id, comment_count: inlineComments.length };
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new GitHubApiError(
      `Failed to create review on ${input.owner}/${input.repo}#${input.pull_number}`,
      status,
      { cause: err },
    );
  }
}

export function renderCommentBody(c: PostedComment): string {
  const severityTag = c.severity.toUpperCase();
  const confTag = c.confidence === 'low' ? ' · low confidence' : '';
  const heading = `**[${severityTag} · ${c.category}${confTag}]** ${c.title}`;
  const why = c.why_it_matters;
  const suggestion = c.suggestion
    ? `\n\n\`\`\`suggestion\n${c.suggestion.replace(/\n$/, '')}\n\`\`\``
    : '';
  const provenance = renderProvenanceTag(c);
  return `${heading}\n\n${why}${suggestion}${provenance}`;
}

/**
 * Renders a small inline tag identifying the scanner that produced a finding.
 * AI-originated comments (no `source` field, or `source.kind === 'agent'`)
 * produce no tag so their rendered body is unchanged.
 */
function renderProvenanceTag(c: PostedComment): string {
  if (!c.source || c.source.kind !== 'scanner') return '';
  switch (c.source.scanner) {
    case 'dependency-cve': {
      // Prefer the explicit CVE/GHSA alias when OSV provided one. Fall back
      // to the rule_id with the `osv:` prefix stripped (RUSTSEC, PYSEC,
      // etc. don't have CVE/GHSA aliases but we don't want to render
      // `_via OSV · osv:PYSEC-…_` with the redundant prefix).
      const id =
        c.source.cve_id ??
        c.source.ghsa_id ??
        c.source.rule_id?.replace(/^osv:/, '') ??
        '';
      return `\n\n_via OSV · ${id}_`;
    }
    case 'secrets':
      return '\n\n_via secrets scan_';
    case 'sast':
      return '\n\n_via SAST_';
    case 'container-cve':
      return '\n\n_via container scan_';
  }
}
