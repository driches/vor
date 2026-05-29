import { describe, expect, it, vi } from 'vitest';
import type { PostedComment } from '../types.js';
import { AGENT_REVIEW_MARKER } from './prior-reviews.js';
import { postReview, renderCommentBody } from './review-poster.js';

function mockOctokit(): { rest: { pulls: { createReview: ReturnType<typeof vi.fn> } } } {
  return {
    rest: {
      pulls: {
        createReview: vi.fn().mockResolvedValue({ data: { id: 9999 } }),
      },
    },
  };
}

const baseComment = (over: Partial<PostedComment> = {}): PostedComment => ({
  severity: 'important',
  file_path: 'src/foo.ts',
  line: 42,
  side: 'RIGHT',
  category: 'bug',
  title: 'Missing await',
  why_it_matters: 'Promise rejects silently; user sees stale data.',
  suggestion: 'await fetchData()',
  confidence: 'high',
  ...over,
});

describe('renderCommentBody', () => {
  it('includes severity tag, category, title, and why_it_matters', () => {
    const body = renderCommentBody(baseComment());
    expect(body).toContain('[IMPORTANT · bug]');
    expect(body).toContain('Missing await');
    expect(body).toContain('Promise rejects silently');
  });

  it('renders suggestion in a suggestion block', () => {
    const body = renderCommentBody(baseComment({ suggestion: 'await foo();' }));
    expect(body).toMatch(/```suggestion\nawait foo\(\);\n```/);
  });

  it('omits suggestion block when no suggestion', () => {
    const body = renderCommentBody(baseComment({ suggestion: undefined, severity: 'minor' }));
    expect(body).not.toContain('```suggestion');
  });

  it('annotates low confidence', () => {
    const body = renderCommentBody(baseComment({ confidence: 'low' }));
    expect(body).toContain('low confidence');
  });

  it('uppercases severity', () => {
    expect(renderCommentBody(baseComment({ severity: 'critical' }))).toContain('CRITICAL');
    expect(renderCommentBody(baseComment({ severity: 'nit' }))).toContain('NIT');
  });
});

describe('postReview', () => {
  it('posts a single review with all comments', async () => {
    const octokit = mockOctokit();
    const result = await postReview(octokit as never, {
      owner: 'foo',
      repo: 'bar',
      pull_number: 1,
      commit_id: 'abc123',
      event: 'COMMENT',
      body: 'Summary text',
      comments: [baseComment(), baseComment({ line: 50 })],
    });
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledOnce();
    expect(result.review_id).toBe(9999);
    expect(result.comment_count).toBe(2);

    const call = octokit.rest.pulls.createReview.mock.calls[0]![0];
    expect(call.comments).toHaveLength(2);
    expect(call.event).toBe('COMMENT');
    expect(call.body).toContain(AGENT_REVIEW_MARKER);
    expect(call.body).toContain('Summary text');
  });

  it('handles multi-line comments with start_line', async () => {
    const octokit = mockOctokit();
    await postReview(octokit as never, {
      owner: 'foo',
      repo: 'bar',
      pull_number: 1,
      commit_id: 'abc',
      event: 'COMMENT',
      body: 'sum',
      comments: [baseComment({ start_line: 40, line: 42 })],
    });
    const call = octokit.rest.pulls.createReview.mock.calls[0]![0];
    expect(call.comments[0].start_line).toBe(40);
    expect(call.comments[0].start_side).toBe('RIGHT');
    expect(call.comments[0].line).toBe(42);
  });

  it('renders inline body via renderCommentBody', async () => {
    const octokit = mockOctokit();
    await postReview(octokit as never, {
      owner: 'foo',
      repo: 'bar',
      pull_number: 1,
      commit_id: 'abc',
      event: 'COMMENT',
      body: 'sum',
      comments: [baseComment({ title: 'A specific title here' })],
    });
    const call = octokit.rest.pulls.createReview.mock.calls[0]![0];
    expect(call.comments[0].body).toContain('A specific title here');
  });

  it('preserves event type', async () => {
    const octokit = mockOctokit();
    await postReview(octokit as never, {
      owner: 'foo',
      repo: 'bar',
      pull_number: 1,
      commit_id: 'abc',
      event: 'APPROVE',
      body: 'lgtm',
      comments: [],
    });
    expect(octokit.rest.pulls.createReview.mock.calls[0]![0].event).toBe('APPROVE');
  });

  it('throws GitHubApiError on failure', async () => {
    const octokit = {
      rest: {
        pulls: {
          createReview: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('boom'), { status: 422 })),
        },
      },
    };
    await expect(
      postReview(octokit as never, {
        owner: 'foo',
        repo: 'bar',
        pull_number: 1,
        commit_id: 'abc',
        event: 'COMMENT',
        body: 'sum',
        comments: [],
      }),
    ).rejects.toThrow(/Failed to create review/);
  });
});
