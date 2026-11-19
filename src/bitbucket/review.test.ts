import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createBitbucketPlatformMock = vi.fn();
const runReviewWithPlatformMock = vi.fn();

vi.mock('./platform.js', () => ({
  createBitbucketPlatform: (...args: unknown[]) => createBitbucketPlatformMock(...args),
}));

vi.mock('../platform/runner.js', () => ({
  runReviewWithPlatform: (...args: unknown[]) => runReviewWithPlatformMock(...args),
}));

import { runBitbucketReview } from './review.js';

const ORIGINAL_ENV = { ...process.env };

describe('runBitbucketReview', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    createBitbucketPlatformMock.mockReset();
    runReviewWithPlatformMock.mockReset();
    createBitbucketPlatformMock.mockReturnValue({
      id: 'bitbucket',
      displayName: 'Bitbucket',
      owner: 'env-ws',
      repo: 'env-repo',
      pull_number: 17,
      repoLabel: 'env-ws/env-repo',
      authSecrets: ['token'],
      fileReader: {},
      fetchPRContext: async () => {
        throw new Error('not used');
      },
      fetchPriorReviewThreads: async () => [],
      supersedePriorReviews: async () => 0,
      postReview: async () => ({ comment_count: 0 }),
    });
    runReviewWithPlatformMock.mockResolvedValue({
      comment_count: 0,
      ended: 'summary_posted',
      turns: 0,
      cost_usd: 0,
      dry_run: false,
      kept_comments: [],
    });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('fails fast when required Bitbucket identifiers are missing', async () => {
    delete process.env.BITBUCKET_WORKSPACE;
    delete process.env.BITBUCKET_REPO_SLUG;
    delete process.env.BITBUCKET_PR_ID;
    process.env.BITBUCKET_API_EMAIL = 'bot@example.com';
    process.env.BITBUCKET_API_TOKEN = 'token';

    await expect(runBitbucketReview()).rejects.toThrow('Missing Bitbucket workspace/repo/pr');
  });

  it('rejects malformed pipeline pull request ids', async () => {
    process.env.BITBUCKET_WORKSPACE = 'env-ws';
    process.env.BITBUCKET_REPO_SLUG = 'env-repo';
    process.env.BITBUCKET_PR_ID = '17x';
    process.env.BITBUCKET_API_EMAIL = 'bot@example.com';
    process.env.BITBUCKET_API_TOKEN = 'token';

    await expect(runBitbucketReview()).rejects.toThrow('Missing Bitbucket workspace/repo/pr');
    expect(createBitbucketPlatformMock).not.toHaveBeenCalled();
  });

  it('uses Pipelines env defaults and forwards review options', async () => {
    process.env.BITBUCKET_WORKSPACE = 'env-ws';
    process.env.BITBUCKET_REPO_SLUG = 'env-repo';
    process.env.BITBUCKET_PR_ID = '17';
    process.env.BITBUCKET_CLONE_DIR = '/tmp/clone';
    process.env.BITBUCKET_API_EMAIL = 'bot@example.com';
    process.env.BITBUCKET_API_TOKEN = 'token';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';

    await runBitbucketReview({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      dryRun: true,
      apiBaseUrl: 'https://bitbucket.example/2.0',
    });

    expect(createBitbucketPlatformMock).toHaveBeenCalledWith({
      workspace: 'env-ws',
      repoSlug: 'env-repo',
      pullRequestId: 17,
      email: 'bot@example.com',
      apiToken: 'token',
      apiBaseUrl: 'https://bitbucket.example/2.0',
    });
    expect(runReviewWithPlatformMock).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropic_api_key: 'sk-ant',
        model_override: 'claude-sonnet-4-6',
        provider_override: 'anthropic',
        dry_run: true,
        workspace_dir: '/tmp/clone',
      }),
    );
  });

  it('lets explicit identifiers override Pipelines environment values', async () => {
    process.env.BITBUCKET_WORKSPACE = 'env-ws';
    process.env.BITBUCKET_REPO_SLUG = 'env-repo';
    process.env.BITBUCKET_PR_ID = '17';
    process.env.BITBUCKET_API_EMAIL = 'env@example.com';
    process.env.BITBUCKET_API_TOKEN = 'env-token';

    await runBitbucketReview({
      workspace: 'flag-ws',
      repo: 'flag-repo',
      pr: 42,
      email: 'flag@example.com',
      apiToken: 'flag-token',
    });

    expect(createBitbucketPlatformMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: 'flag-ws',
        repoSlug: 'flag-repo',
        pullRequestId: 42,
        email: 'flag@example.com',
        apiToken: 'flag-token',
      }),
    );
  });
});
