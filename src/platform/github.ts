import type { Octokit } from '@octokit/rest';
import { createOctokit } from '../github/client.js';
import { FileReader } from '../github/file-reader.js';
import { fetchPRContext } from '../github/pr-context.js';
import { dismissPriorAgentReviews } from '../github/prior-reviews.js';
import { fetchPriorReviewThreads } from '../github/prior-review-threads.js';
import { postReview } from '../github/review-poster.js';
import type { ReviewPlatform } from './types.js';

export interface GitHubPlatformInput {
  owner: string;
  repo: string;
  pull_number: number;
  github_token: string;
  octokitFactory?: (opts: { auth: string }) => Octokit;
}

export function createGitHubPlatform(input: GitHubPlatformInput): ReviewPlatform {
  const octokit = (input.octokitFactory ?? createOctokit)({ auth: input.github_token });
  const ref = {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
  };
  const fileReader = new FileReader(octokit);

  return {
    id: 'github',
    displayName: 'GitHub',
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
    repoLabel: `${input.owner}/${input.repo}`,
    authSecrets: input.github_token ? [input.github_token] : [],
    fileReader,
    fetchPRContext: () => fetchPRContext(octokit, ref),
    fetchPriorReviewThreads: () => fetchPriorReviewThreads(octokit, ref),
    supersedePriorReviews: (context) =>
      dismissPriorAgentReviews(octokit, ref, context.metadata.head_sha),
    postReview: async (review) => {
      const posted = await postReview(octokit, {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pull_number,
        commit_id: review.commit_id,
        event: review.event,
        body: review.body,
        comments: review.comments,
      });
      return {
        review_id: posted.review_id,
        comment_count: posted.comment_count,
      };
    },
  };
}
