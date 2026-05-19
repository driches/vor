/**
 * Sticky-review behavior: find prior reviews posted by this agent and dismiss
 * them so the new review supersedes the old one.
 *
 * The agent identifies itself via a hidden marker embedded in the review body:
 *   <!-- driches/code-review: agent-review v1 -->
 * Any review whose body contains this marker is considered a prior agent review.
 */

import type { Octokit } from '@octokit/rest';
import { logger } from '../util/logger.js';

export const AGENT_REVIEW_MARKER = '<!-- driches/code-review: agent-review v1 -->';

export interface PriorReviewsRef {
  owner: string;
  repo: string;
  pull_number: number;
}

export async function dismissPriorAgentReviews(
  octokit: Octokit,
  ref: PriorReviewsRef,
  newHeadSha: string,
): Promise<number> {
  let page = 1;
  let dismissed = 0;

  while (true) {
    const r = await octokit.rest.pulls.listReviews({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
      page,
    });

    for (const review of r.data) {
      const body = review.body ?? '';
      if (!body.includes(AGENT_REVIEW_MARKER)) continue;
      // Skip already-dismissed reviews and reviews that aren't dismissable
      // (COMMENT reviews don't need dismissal — they're informational).
      if (review.state === 'DISMISSED') continue;
      if (review.state !== 'CHANGES_REQUESTED' && review.state !== 'APPROVED') continue;

      try {
        await octokit.rest.pulls.dismissReview({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pull_number,
          review_id: review.id,
          message: `Superseded by review on commit ${newHeadSha.slice(0, 7)}.`,
        });
        dismissed += 1;
      } catch (err) {
        void logger.warn(
          `Failed to dismiss prior review ${review.id}: ${(err as Error).message}`,
        );
      }
    }

    if (r.data.length < 100) break;
    page += 1;
  }

  return dismissed;
}
