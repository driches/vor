import { describe, expect, it, vi } from 'vitest';
import { AGENT_REVIEW_MARKER, dismissPriorAgentReviews } from './prior-reviews.js';

function mockReviews(reviews: Array<{ id: number; body?: string; state: string }>): unknown {
  return {
    rest: {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({ data: reviews }),
        dismissReview: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe('dismissPriorAgentReviews', () => {
  it('dismisses reviews containing the marker that are CHANGES_REQUESTED or APPROVED', async () => {
    const octokit = mockReviews([
      { id: 1, body: `human review`, state: 'COMMENTED' },
      { id: 2, body: `${AGENT_REVIEW_MARKER}\n\nbody`, state: 'CHANGES_REQUESTED' },
      { id: 3, body: `${AGENT_REVIEW_MARKER}\n\nbody`, state: 'APPROVED' },
      { id: 4, body: 'human approves', state: 'APPROVED' },
    ]);
    const n = await dismissPriorAgentReviews(
      octokit as never,
      { owner: 'foo', repo: 'bar', pull_number: 1 },
      'newcommit123',
    );
    expect(n).toBe(2);
    const calls = (octokit as never as { rest: { pulls: { dismissReview: { mock: { calls: unknown[][] } } } } })
      .rest.pulls.dismissReview.mock.calls;
    expect(calls.map((c) => (c[0] as { review_id: number }).review_id).sort()).toEqual([2, 3]);
  });

  it('does not dismiss COMMENT-state reviews even if marker present', async () => {
    const octokit = mockReviews([
      { id: 1, body: `${AGENT_REVIEW_MARKER}\n\nbody`, state: 'COMMENTED' },
    ]);
    const n = await dismissPriorAgentReviews(
      octokit as never,
      { owner: 'foo', repo: 'bar', pull_number: 1 },
      'sha',
    );
    expect(n).toBe(0);
  });

  it('does not dismiss already-DISMISSED reviews', async () => {
    const octokit = mockReviews([
      { id: 1, body: `${AGENT_REVIEW_MARKER}\n\nbody`, state: 'DISMISSED' },
    ]);
    expect(
      await dismissPriorAgentReviews(
        octokit as never,
        { owner: 'foo', repo: 'bar', pull_number: 1 },
        'sha',
      ),
    ).toBe(0);
  });

  it('ignores reviews without the marker', async () => {
    const octokit = mockReviews([{ id: 1, body: 'human review', state: 'CHANGES_REQUESTED' }]);
    expect(
      await dismissPriorAgentReviews(
        octokit as never,
        { owner: 'foo', repo: 'bar', pull_number: 1 },
        'sha',
      ),
    ).toBe(0);
  });

  it('continues if a single dismiss call fails', async () => {
    const octokit = {
      rest: {
        pulls: {
          listReviews: vi.fn().mockResolvedValue({
            data: [
              { id: 1, body: `${AGENT_REVIEW_MARKER}`, state: 'CHANGES_REQUESTED' },
              { id: 2, body: `${AGENT_REVIEW_MARKER}`, state: 'APPROVED' },
            ],
          }),
          dismissReview: vi
            .fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({}),
        },
      },
    };
    const n = await dismissPriorAgentReviews(
      octokit as never,
      { owner: 'foo', repo: 'bar', pull_number: 1 },
      'sha',
    );
    expect(n).toBe(1); // second one succeeded
  });
});
