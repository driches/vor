import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchPriorReviewThreads } from './prior-review-threads.js';
import { AGENT_REVIEW_MARKER } from './prior-reviews.js';

interface FakeReview {
  id: number;
  body: string | null;
  state?: string;
}
interface FakeComment {
  id: number;
  path: string;
  line: number | null;
  original_line?: number | null;
  body: string;
  user: { login: string } | null;
  in_reply_to_id?: number | null;
  pull_request_review_id?: number | null;
}

function makeOctokit(reviews: FakeReview[], comments: FakeComment[]): Octokit {
  return {
    rest: {
      pulls: {
        // Paginate by `page`: return the page-th slice of 100, [] past the end.
        listReviews: vi.fn(async (args: { page?: number }) => ({
          data: (args.page ?? 1) === 1 ? reviews : [],
        })),
        listReviewComments: vi.fn(async (args: { page?: number }) => ({
          data: (args.page ?? 1) === 1 ? comments : [],
        })),
      },
    },
  } as unknown as Octokit;
}

const ref = { owner: 'driches', repo: 'vor', pull_number: 7 };
const agentReview: FakeReview = {
  id: 100,
  body: `${AGENT_REVIEW_MARKER}\n\n### Findings`,
  state: 'COMMENTED',
};

describe('fetchPriorReviewThreads', () => {
  it('returns [] when there is no prior agent review', async () => {
    const octokit = makeOctokit(
      [{ id: 1, body: 'human review, no marker' }],
      [{ id: 9, path: 'a.ts', line: 1, body: 'x', user: { login: 'someone' } }],
    );
    expect(await fetchPriorReviewThreads(octokit, ref)).toEqual([]);
    // Short-circuits before listing comments when no agent review is present.
    expect(octokit.rest.pulls.listReviewComments).not.toHaveBeenCalled();
  });

  it('reconstructs an agent finding with its author reply', async () => {
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 10,
          path: 'src/foo.ts',
          line: 42,
          body: '**[CRITICAL · security]** SQL injection on the login path',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        {
          id: 11,
          path: 'src/foo.ts',
          line: 42,
          body: "Won't fix — this query is parameterized one layer up, by design.",
          user: { login: 'author' },
          in_reply_to_id: 10,
          pull_request_review_id: null,
        },
      ],
    );

    const threads = await fetchPriorReviewThreads(octokit, ref);
    expect(threads).toHaveLength(1);
    const t = threads[0]!;
    expect(t.file_path).toBe('src/foo.ts');
    expect(t.line).toBe(42);
    expect(t.outdated).toBe(false);
    // Markdown emphasis stripped, severity tag kept.
    expect(t.finding_excerpt).toBe('[CRITICAL · security] SQL injection on the login path');
    expect(t.replies).toEqual([
      {
        author: 'author',
        excerpt: "Won't fix — this query is parameterized one layer up, by design.",
      },
    ]);
  });

  it('flags from_dismissable_review by the originating review state', async () => {
    const octokit = makeOctokit(
      [
        { id: 100, body: AGENT_REVIEW_MARKER, state: 'COMMENTED' },
        { id: 101, body: AGENT_REVIEW_MARKER, state: 'CHANGES_REQUESTED' },
      ],
      [
        {
          id: 1,
          path: 'a.ts',
          line: 1,
          body: 'comment-review finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        {
          id: 2,
          path: 'b.ts',
          line: 1,
          body: 'blocking-review finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 101,
        },
      ],
    );

    const threads = await fetchPriorReviewThreads(octokit, ref);
    const byPath = new Map(threads.map((t) => [t.file_path, t]));
    expect(byPath.get('a.ts')!.from_dismissable_review).toBe(false);
    expect(byPath.get('b.ts')!.from_dismissable_review).toBe(true);
  });

  it('ignores inline comments that belong to non-agent reviews', async () => {
    const octokit = makeOctokit(
      [agentReview, { id: 200, body: 'human reviewer summary' }],
      [
        {
          id: 20,
          path: 'a.ts',
          line: 1,
          body: 'human nit',
          user: { login: 'human' },
          pull_request_review_id: 200,
        },
        {
          id: 21,
          path: 'b.ts',
          line: 2,
          body: '**[MINOR · style]** agent nit',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
      ],
    );

    const threads = await fetchPriorReviewThreads(octokit, ref);
    expect(threads.map((t) => t.file_path)).toEqual(['b.ts']);
  });

  it('falls back to original_line and flags outdated when line is null', async () => {
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 30,
          path: 'src/x.ts',
          line: null,
          original_line: 88,
          body: 'stale finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
      ],
    );

    const [t] = await fetchPriorReviewThreads(octokit, ref);
    expect(t!.line).toBe(88);
    expect(t!.outdated).toBe(true);
  });

  it('resolves chained replies to the agent root', async () => {
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 40,
          path: 'src/y.ts',
          line: 5,
          body: 'root finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        {
          id: 41,
          path: 'src/y.ts',
          line: 5,
          body: 'first reply',
          user: { login: 'author' },
          in_reply_to_id: 40,
        },
        // A reply pointing at the previous reply rather than the root.
        {
          id: 42,
          path: 'src/y.ts',
          line: 5,
          body: 'second reply',
          user: { login: 'author' },
          in_reply_to_id: 41,
        },
      ],
    );

    const [t] = await fetchPriorReviewThreads(octokit, ref);
    expect(t!.replies.map((r) => r.excerpt)).toEqual(['first reply', 'second reply']);
  });

  it('skips a leading blockquote so the actual reply (pushback) survives', async () => {
    // GitHub's reply UI prepends `> <quoted finding>` above the real response.
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 60,
          path: 'q.ts',
          line: 1,
          body: 'finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        {
          id: 61,
          path: 'q.ts',
          line: 1,
          body: "> **[CRITICAL · security]** SQL injection\n\nWon't fix — parameterized upstream, by design.",
          user: { login: 'author' },
          in_reply_to_id: 60,
        },
      ],
    );

    const [t] = await fetchPriorReviewThreads(octokit, ref);
    expect(t!.replies[0]!.excerpt).toBe("Won't fix — parameterized upstream, by design.");
  });

  it('falls back to the quoted line when a reply is nothing but a quote', async () => {
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 70,
          path: 'q2.ts',
          line: 1,
          body: 'finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        {
          id: 71,
          path: 'q2.ts',
          line: 1,
          body: '> just a quote',
          user: { login: 'author' },
          in_reply_to_id: 70,
        },
      ],
    );

    const [t] = await fetchPriorReviewThreads(octokit, ref);
    expect(t!.replies[0]!.excerpt).toBe('just a quote');
  });

  it('renders a reply author as "unknown" when the user is null', async () => {
    const octokit = makeOctokit(
      [agentReview],
      [
        {
          id: 50,
          path: 'z.ts',
          line: 1,
          body: 'finding',
          user: { login: 'vor-bot' },
          pull_request_review_id: 100,
        },
        { id: 51, path: 'z.ts', line: 1, body: 'ghost reply', user: null, in_reply_to_id: 50 },
      ],
    );

    const [t] = await fetchPriorReviewThreads(octokit, ref);
    expect(t!.replies[0]!.author).toBe('unknown');
  });
});
