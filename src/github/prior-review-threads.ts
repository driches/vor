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
  /**
   * True when the originating review's state is CHANGES_REQUESTED or APPROVED —
   * the states `dismissPriorAgentReviews` dismisses. Such a finding loses its
   * active (blocking) state IF the sticky step runs this turn, so the
   * orchestrator must not blanket-suppress it then; see the filter at the call
   * site. (Config-dependent: only matters when `review.sticky` is on.)
   */
  from_dismissable_review: boolean;
  /**
   * True when the originating review's state is already DISMISSED (a prior
   * sticky run superseded it). Such a finding has no active backing regardless
   * of the current `review.sticky` setting, so it must never blanket-suppress a
   * still-valid finding on a rerun.
   */
  already_dismissed: boolean;
  /**
   * True when at least one reply REJECTS the finding (matches the pushback
   * phrases the agent prompt names — "won't fix", "by design", etc.). Distinct
   * from "has any reply": an acknowledgement like "good catch" or "fixed in
   * next push" is a reply but NOT pushback. Used to decide whether a thread
   * that loses its active backing is worth keeping in the dedup block.
   */
  has_pushback: boolean;
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

// GitHub review states that `dismissPriorAgentReviews` dismisses on a sticky
// run (it skips COMMENTED / DISMISSED / PENDING). Findings from these reviews
// go inactive when that step runs.
const DISMISSABLE_STATES = new Set(['CHANGES_REQUESTED', 'APPROVED']);

// Phrases that signal the author REJECTED a finding — mirrors the pushback
// language named in the agent system prompt. Deliberately narrow: an
// acknowledgement ("good catch", "fixed in next push", "will address") is a
// reply but NOT a rejection, and must not match, or a soon-/already-dismissed
// blocking finding would be wrongly suppressed.
const REJECTION_PATTERNS: RegExp[] = [
  /won['’]?t\s*fix/i,
  /wont\s*fix/i,
  /won['’]?t\s*do/i,
  /wont\s*do/i,
  /by\s*design/i,
  // `\b` so "unintentional" (an acknowledgement) doesn't match "intentional"
  // and wrongly suppress a finding. addressing #58 (Codex review).
  /\bintentional/i,
  /as\s*(documented|designed|intended)/i,
  /working\s*as\s*intended/i,
  /\bwai\b/i,
  /disagree/i,
  /not\s*a\s*(real\s*)?(bug|issue|problem)/i,
];

/** True when a reply body rejects the finding (vs. merely acknowledging it). */
export function isRejectionReply(body: string): boolean {
  // Classify only the author's OWN text, not quoted review content. GitHub's
  // reply UI prepends `> <quoted finding>`, which can itself contain rejection
  // phrases (e.g. a prior "by design" finding); matching the quote would
  // wrongly flag an acknowledgement like "good catch — fixing" as pushback and
  // suppress a still-open blocking finding. Mirrors the blockquote skip in
  // `excerpt`. addressing #58 (Codex P2 review).
  const authorText = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n');
  return REJECTION_PATTERNS.some((re) => re.test(authorText));
}

export async function fetchPriorReviewThreads(
  octokit: Octokit,
  ref: PriorThreadsRef,
): Promise<PriorReviewThread[]> {
  const agentReviewStates = await collectAgentReviewStates(octokit, ref);
  // No prior agent review → nothing to fold in. Skip the second API call.
  if (agentReviewStates.size === 0) return [];

  const comments = await listAllReviewComments(octokit, ref);
  const byId = new Map<number, ReviewCommentLike>();
  for (const c of comments) byId.set(c.id, c);

  // A root agent finding is an inline comment posted as part of one of the
  // agent's reviews that is not itself a reply.
  const isAgentRoot = (c: ReviewCommentLike): boolean =>
    c.in_reply_to_id == null &&
    c.pull_request_review_id != null &&
    agentReviewStates.has(c.pull_request_review_id);

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
    const rawReplies = (repliesByRoot.get(c.id) ?? []).sort((a, b) => a.id - b.id);
    const replies = rawReplies.map((r) => ({
      author: r.user?.login ?? 'unknown',
      excerpt: excerpt(r.body),
    }));
    // Classify on the full reply bodies (before excerpt truncation) so a
    // rejection phrase past the first ~200 chars still counts.
    const has_pushback = rawReplies.some((r) => isRejectionReply(r.body));
    const state = agentReviewStates.get(c.pull_request_review_id!) ?? '';
    threads.push({
      file_path: c.path,
      line: c.line ?? c.original_line ?? null,
      outdated: c.line == null,
      finding_excerpt: excerpt(c.body),
      from_dismissable_review: DISMISSABLE_STATES.has(state),
      already_dismissed: state === 'DISMISSED',
      has_pushback,
      replies,
    });
  }
  return threads;
}

/** Map each agent review id (body carries the marker) to its GitHub state. */
async function collectAgentReviewStates(
  octokit: Octokit,
  ref: PriorThreadsRef,
): Promise<Map<number, string>> {
  const states = new Map<number, string>();
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
      if ((review.body ?? '').includes(AGENT_REVIEW_MARKER)) states.set(review.id, review.state);
    }
    if (r.data.length < 100) break;
    page += 1;
  }
  return states;
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
    // `r.data` is the full Octokit listReviewComments item type (dozens of
    // fields); ReviewCommentLike is a deliberate read-subset. The cast is safe
    // because every field we declare is present in the API response with the
    // same type — we only narrow what we read, never reshape it.
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
 * First meaningful line of a comment body, stripped of Markdown emphasis so the
 * agent reads it cleanly. The agent's own comments lead with
 * `**[SEVERITY · category]** Title`; stripping `**`/backticks keeps the
 * bracketed severity tag, which is the useful signal.
 *
 * Blockquote lines are skipped: GitHub's reply UI prepends `> <quoted comment>`
 * above the actual response, so the first non-blank line of a reply is often
 * the quoted finding, not the author's reply. Picking it would drop the real
 * response — including pushback phrases ("won't fix", "by design") the agent
 * must see — which is exactly the finding this feature exists to suppress.
 * Falls back to the first non-blank line only when every line is quoted.
 * addressing #58 (Codex P2 review).
 */
function excerpt(body: string, max = EXCERPT_MAX): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const line = lines.find((l) => !l.startsWith('>')) ?? lines[0] ?? '';
  const cleaned = line
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[>#\s-]+/, '')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}
