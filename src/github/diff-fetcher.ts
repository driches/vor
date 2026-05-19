/**
 * Fetches the unified diff for a PR. Uses the Accept: vnd.diff media type
 * so GitHub returns the raw patch text rather than JSON.
 */
import type { Octokit } from '@octokit/rest';
import { GitHubApiError } from '../util/errors.js';

export interface DiffRef {
  owner: string;
  repo: string;
  pull_number: number;
}

export async function fetchPullRequestDiff(octokit: Octokit, ref: DiffRef): Promise<string> {
  try {
    const response = await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      mediaType: { format: 'diff' },
    });
    // With format: 'diff', the response data is the raw diff string,
    // but octokit's types still say PullRequest. Cast.
    return response.data as unknown as string;
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new GitHubApiError(
      `Failed to fetch diff for ${ref.owner}/${ref.repo}#${ref.pull_number}`,
      status,
      { cause: err },
    );
  }
}
