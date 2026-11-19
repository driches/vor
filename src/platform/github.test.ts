import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import type { PostedComment } from '../types.js';
import type { PlatformReviewInput } from './types.js';
import { createGitHubPlatform } from './github.js';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface GitHubBaselineFixture {
  github_adapter: {
    prior_threads: unknown[];
    dismiss_review: Record<string, unknown>;
    create_review: Record<string, unknown>;
  };
}

describe('GitHub platform parity baseline', () => {
  it('preserves prior threads, sticky dismissal, file reads, and createReview payloads', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(repoRoot, 'tests/fixtures/platform/github-baseline.json'), 'utf-8'),
    ) as GitHubBaselineFixture;
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,3 @@',
      '+export function app() {',
      '+  return 1;',
      '+}',
      '',
    ].join('\n');
    const createReview = vi.fn().mockResolvedValue({ data: { id: 12345 } });
    const dismissReview = vi.fn().mockResolvedValue({ data: {} });
    const get = vi.fn(async (input: { mediaType?: { format?: string } }) => {
      if (input.mediaType?.format === 'diff') return { data: diff };
      return {
        data: {
          number: 1,
          title: 'Baseline PR',
          body: '',
          user: { login: 'doug' },
          base: { sha: 'base000', ref: 'main' },
          head: { sha: 'head111', ref: 'feature' },
          labels: [],
          changed_files: 1,
          additions: 3,
          deletions: 0,
          draft: false,
        },
      };
    });
    const octokit = {
      rest: {
        pulls: {
          get,
          listFiles: vi.fn().mockResolvedValue({
            data: [{ filename: 'src/app.ts', changes: 3, patch: diff }],
          }),
          listReviews: vi.fn().mockResolvedValue({
            data: [
              {
                id: 41,
                body: '<!-- driches/vor: agent-review v1 -->\n\nOld review',
                state: 'CHANGES_REQUESTED',
              },
              {
                id: 42,
                body: '<!-- driches/vor: agent-review v1 -->\n\nComment review',
                state: 'COMMENTED',
              },
              { id: 43, body: 'Human review', state: 'APPROVED' },
            ],
          }),
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 101,
                path: 'src/app.ts',
                line: 5,
                original_line: 5,
                body: '**[IMPORTANT · bug]** Existing finding',
                user: { login: 'vor' },
                pull_request_review_id: 41,
              },
              {
                id: 102,
                path: 'src/app.ts',
                line: 5,
                body: "> quoted finding\n\nThis is by design; won't fix.",
                user: { login: 'author' },
                in_reply_to_id: 101,
              },
            ],
          }),
          dismissReview,
          createReview,
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: {
              type: 'file',
              content: Buffer.from('export function app() {}\n').toString('base64'),
              encoding: 'base64',
              sha: 'blob111',
            },
          }),
        },
      },
    } as unknown as Octokit;
    const platform = createGitHubPlatform({
      owner: 'driches',
      repo: 'test',
      pull_number: 1,
      github_token: 'ghs_test',
      octokitFactory: () => octokit,
    });

    const context = await platform.fetchPRContext();
    expect(context.metadata).toMatchObject({
      number: 1,
      head_sha: 'head111',
      changed_file_count: 1,
    });
    await expect(
      platform.fileReader.read({
        owner: 'driches',
        repo: 'test',
        path: 'src/app.ts',
        ref: 'head111',
      }),
    ).resolves.toBe('export function app() {}\n');
    await expect(platform.fetchPriorReviewThreads(context)).resolves.toEqual(
      fixture.github_adapter.prior_threads,
    );
    await expect(platform.supersedePriorReviews(context)).resolves.toBe(1);
    expect(dismissReview).toHaveBeenCalledWith(fixture.github_adapter.dismiss_review);

    const comment: PostedComment = {
      severity: 'important',
      file_path: 'src/app.ts',
      line: 5,
      side: 'RIGHT',
      category: 'bug',
      title: 'Guard missing null profile',
      why_it_matters: 'The code can throw when the profile is absent.',
      suggestion: 'if (!profile) return null;',
      confidence: 'high',
    };
    const review: PlatformReviewInput = {
      commit_id: 'head111',
      event: 'COMMENT',
      body: 'Baseline summary',
      comments: [comment],
    };
    await expect(platform.postReview(review)).resolves.toEqual({
      review_id: 12345,
      comment_count: 1,
    });
    expect(createReview).toHaveBeenCalledWith(fixture.github_adapter.create_review);
  });
});
