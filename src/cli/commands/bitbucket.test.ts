import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runBitbucketReviewMock } = vi.hoisted(() => ({
  runBitbucketReviewMock: vi.fn(),
}));

vi.mock('../../bitbucket/review.js', () => ({
  runBitbucketReview: (...args: unknown[]) => runBitbucketReviewMock(...args),
}));

import { buildProgram } from '../index.js';

describe('vor bitbucket review CLI', () => {
  beforeEach(() => {
    runBitbucketReviewMock.mockReset();
    runBitbucketReviewMock.mockResolvedValue({
      comment_count: 2,
      ended: 'summary_posted',
      turns: 1,
      cost_usd: 0.01,
      dry_run: false,
      kept_comments: [],
    });
  });

  it('forwards explicit flags over environment defaults', async () => {
    await buildProgram().parseAsync([
      'node',
      'vor',
      'bitbucket',
      'review',
      '--workspace',
      'flag-ws',
      '--repo',
      'flag-repo',
      '--pr',
      '42',
      '--config',
      'config/vor.yml',
      '--model',
      'gpt-5.6-sol',
      '--provider',
      'openai',
      '--dry-run',
      '--api-base-url',
      'https://bitbucket.example/2.0',
    ]);

    expect(runBitbucketReviewMock).toHaveBeenCalledWith({
      workspace: 'flag-ws',
      repo: 'flag-repo',
      pr: 42,
      configPath: 'config/vor.yml',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      dryRun: true,
      apiBaseUrl: 'https://bitbucket.example/2.0',
    });
  });

  it('rejects malformed and non-positive pull request ids', async () => {
    await expect(
      buildProgram().parseAsync(['node', 'vor', 'bitbucket', 'review', '--pr', '12x']),
    ).rejects.toThrow('--pr must be a positive integer');
    await expect(
      buildProgram().parseAsync(['node', 'vor', 'bitbucket', 'review', '--pr', '0']),
    ).rejects.toThrow('--pr must be a positive integer');
    expect(runBitbucketReviewMock).not.toHaveBeenCalled();
  });

  it('rejects unknown providers before starting a review', async () => {
    await expect(
      buildProgram().parseAsync(['node', 'vor', 'bitbucket', 'review', '--provider', 'open-ai']),
    ).rejects.toThrow('Invalid --provider "open-ai"');
    expect(runBitbucketReviewMock).not.toHaveBeenCalled();
  });
});
