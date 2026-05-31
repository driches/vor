/**
 * Reconstruct the agent's OWN prior review threads on a PR, with author replies.
 *
 * The agent posts findings as inline review comments under a review whose body
 * carries {@link AGENT_REVIEW_MARKER}. Those inline comments do NOT each carry
 * the marker — they are identified by their parent review id. With the default
 * `COMMENT` review event, prior inline threads are never dismissed (sticky
 * dismissal in `prior-reviews.ts` only touches CHANGES_REQUESTED / APPROVED
 * reviews), so a re-run on a pushed-to PR would otherwise re-post the same
 * findings as duplicate threads and re-litigate ones the author already
 * rejected. Folding these threads into the agent's user prompt lets it dedup
 * against itself and honor pushback deterministically instead of guessing.
 *
 * This is read-only and best-effort: the orchestrator wraps the call so a
 * failure degrades to "no prior threads" rather than failing the review.
 */

import type { Octokit } from '@octokit/rest';
import { AGENT_REVIEW_MARKER } from './prior-reviews.js';

export interface PriorReviewReply {
  /** GitHub login of the reply author (PR author or another reviewer). */
  author: string;
  /** Trimmed, truncated body of the reply. */
  excerpt: string;
}

export interface PriorReviewThread {
  file_path: string;
  /**
   * Current-HEAD line of the finding. Falls back to `original_line` when GitHub
   * marks the comment outdated (the author pushed past it). `null` when neither
   * is known.
   */
  line: number | null;
  /** True when GitHub no longer anchors the root comment to a current line. */
  outdated: boolean;
  /** First-line excerpt of the agent's original finding (severity tag + title). */
  finding_excerpt: string;
  /** Author replies on the thread, oldest first. */
  replies: PriorReviewReply[];
}

export interface PriorThreadsRef {
  owner: string;
  repo: string;
  pull_number: number;
}

/**
 * Subset of the `pulls.listReviewComments` item shape we read. GitHub returns
 * `line: null` for outdated comments and preserves `original_line`; replies
 * carry `in_reply_to_id`; review-attached comments carry
 * `pull_request_review_id` (reply comments created via the reply endpoint do
 * not, which is one more signal that they are not the agent's own findings).
 */
interface ReviewCommentLike {
  id: number;
  path: string;
  line: number | null;
  original_line?: number | null;
  body: string;
  user: { login: string } | null;
  in_reply_to_id?: number | null;
  pull_request_review_id?: number | null;
}

const EXCERPT_MAX = 200;

export async function fetchPriorReviewThreads(
  octokit: Octokit,
  ref: PriorThreadsRef,
): Promise<PriorReviewThread[]> {
  const agentReviewIds = await collectAgentReviewIds(octokit, ref);
  // No prior agent review → nothing to fold in. Skip the second API call.
  if (agentReviewIds.size === 0) return [];

  const comments = await listAllReviewComments(octokit, ref);
  const byId = new Map<number, ReviewCommentLike>();
  for (const c of comments) byId.set(c.id, c);

  // A root agent finding is an inline comment posted as part of one of the
  // agent's reviews that is not itself a reply.
  const isAgentRoot = (c: ReviewCommentLike): boolean =>
    c.in_reply_to_id == null &&
    c.pull_request_review_id != null &&
    agentReviewIds.has(c.pull_request_review_id);

  // Bucket replies under their resolved root comment id.
  const repliesByRoot = new Map<number, ReviewCommentLike[]>();
  for (const c of comments) {
    if (c.in_reply_to_id == null) continue;
    const rootId = resolveRootId(c, byId);
    if (rootId == null) continue;
    const root = byId.get(rootId);
    if (!root || !isAgentRoot(root)) continue;
    const arr = repliesByRoot.get(rootId) ?? [];
    arr.push(c);
    repliesByRoot.set(rootId, arr);
  }

  const threads: PriorReviewThread[] = [];
  for (const c of comments) {
    if (!isAgentRoot(c)) continue;
    const replies = (repliesByRoot.get(c.id) ?? [])
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ author: r.user?.login ?? 'unknown', excerpt: excerpt(r.body) }));
    threads.push({
      file_path: c.path,
      line: c.line ?? c.original_line ?? null,
      outdated: c.line == null,
      finding_excerpt: excerpt(c.body),
      replies,
    });
  }
  return threads;
}

async function collectAgentReviewIds(
  octokit: Octokit,
  ref: PriorThreadsRef,
): Promise<Set<number>> {
  const ids = new Set<number>();
  let page = 1;
  while (true) {
    const r = await octokit.rest.pulls.listReviews({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
      page,
    });
    for (const review of r.data) {
      if ((review.body ?? '').includes(AGENT_REVIEW_MARKER)) ids.add(review.id);
    }
    if (r.data.length < 100) break;
    page += 1;
  }
  return ids;
}

async function listAllReviewComments(
  octokit: Octokit,
  ref: PriorThreadsRef,
): Promise<ReviewCommentLike[]> {
  const out: ReviewCommentLike[] = [];
  let page = 1;
  while (true) {
    const r = await octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
      page,
    });
    out.push(...(r.data as unknown as ReviewCommentLike[]));
    if (r.data.length < 100) break;
    page += 1;
  }
  return out;
}

/**
 * Walk the `in_reply_to_id` chain to the thread root. GitHub usually points
 * every reply directly at the root, so this resolves in one hop, but chained
 * replies are handled. Returns null on a cycle (defensive — shouldn't happen)
 * and the last known target id when an ancestor isn't in the fetched set.
 */
function resolveRootId(
  start: ReviewCommentLike,
  byId: Map<number, ReviewCommentLike>,
): number | null {
  let current = start;
  const seen = new Set<number>();
  while (current.in_reply_to_id != null) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parent = byId.get(current.in_reply_to_id);
    if (!parent) return current.in_reply_to_id;
    current = parent;
  }
  return current.id;
}

/**
 * First non-blank line of a comment body, stripped of Markdown emphasis so the
 * agent reads the finding headline cleanly. The agent's own comments lead with
 * `**[SEVERITY · category]** Title`; stripping `**`/backticks keeps the
 * bracketed severity tag, which is the useful signal.
 */
function excerpt(body: string, max = EXCERPT_MAX): string {
  const first =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const cleaned = first
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[>#\s-]+/, '')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}
