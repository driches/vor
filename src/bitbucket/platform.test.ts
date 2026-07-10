import { describe, expect, it, vi } from 'vitest';
import type { PostedComment } from '../types.js';
import { AGENT_REVIEW_MARKER } from '../platform/review-marker.js';
import type { PRContext } from '../platform/types.js';
import { createBitbucketPlatform } from './platform.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, { status });
}

function emptyContext(): PRContext {
  return {
    metadata: {
      number: 3,
      title: '',
      body: '',
      author: '',
      base_sha: '',
      head_sha: '',
      base_ref: '',
      head_ref: '',
      labels: [],
      changed_file_count: 0,
      additions: 0,
      deletions: 0,
      draft: false,
    },
    files: [],
    diff: '',
  };
}

describe('createBitbucketPlatform', () => {
  it('maps PR context from metadata, diff, and diffstat', async () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,2 @@',
      '+export function app() {',
      '+}',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/pullrequests/3')) {
        return jsonResponse({
          id: 3,
          title: 'Bitbucket PR',
          description: 'body',
          author: { nickname: 'dev' },
          source: { branch: { name: 'feature' }, commit: { hash: 'head111' } },
          destination: { branch: { name: 'main' }, commit: { hash: 'base000' } },
        });
      }
      if (href.endsWith('/pullrequests/3/diff')) return textResponse(diff);
      if (href.includes('/pullrequests/3/diffstat')) {
        return jsonResponse({
          values: [
            { status: 'modified', lines_added: 2, lines_removed: 0, new: { path: 'src/app.ts' } },
          ],
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const platform = createBitbucketPlatform({
      workspace: 'ws',
      repoSlug: 'repo',
      pullRequestId: 3,
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const context = await platform.fetchPRContext();

    expect(context.metadata).toMatchObject({
      number: 3,
      title: 'Bitbucket PR',
      author: 'dev',
      base_sha: 'base000',
      head_sha: 'head111',
      additions: 2,
      deletions: 0,
      draft: false,
    });
    expect(context.files[0]).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      additions: 2,
      reviewable_lines: [[5, 6]],
    });
  });

  it('posts summary and inline comments and resolves prior Vor comments', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.includes('/comments?') && init?.method !== 'POST') {
        return jsonResponse({
          values: [
            {
              id: 10,
              content: { raw: `${AGENT_REVIEW_MARKER}\n\nold` },
              inline: { path: 'x.ts', to: 1 },
            },
            { id: 11, content: { raw: 'human' }, inline: { path: 'x.ts', to: 2 } },
            { id: 12, content: { raw: `${AGENT_REVIEW_MARKER}\n\nold summary` } },
          ],
        });
      }
      if (href.endsWith('/comments/10/resolve')) return jsonResponse({});
      if (href.endsWith('/approve') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (href.endsWith('/request-changes') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (href.endsWith('/comments') && init?.method === 'POST') {
        return jsonResponse({ id: calls.filter((c) => c.init?.method === 'POST').length });
      }
      if (href.endsWith('/request-changes')) return jsonResponse({});
      throw new Error(`unexpected URL ${href}`);
    });
    const platform = createBitbucketPlatform({
      workspace: 'ws',
      repoSlug: 'repo',
      pullRequestId: 3,
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
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

    await expect(platform.supersedePriorReviews(emptyContext())).resolves.toBe(1);
    await platform.postReview({
      commit_id: 'head111',
      event: 'REQUEST_CHANGES',
      body: 'summary',
      comments: [comment],
    });

    const postBodies = calls
      .filter((call) => call.url.endsWith('/comments') && call.init?.method === 'POST')
      .map((call) => JSON.parse(String(call.init?.body)));
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toMatchObject({ content: { raw: `${AGENT_REVIEW_MARKER}\n\nsummary` } });
    expect(postBodies[1]).toMatchObject({
      inline: { path: 'src/app.ts', to: 5 },
    });
    expect(postBodies[1].content.raw).toContain('Guard missing null profile');
    expect(calls.some((call) => call.url.endsWith('/comments/10/resolve'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/comments/12/resolve'))).toBe(false);
    expect(
      calls.some((call) => call.url.endsWith('/approve') && call.init?.method === 'DELETE'),
    ).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/request-changes'))).toBe(true);
  });

  it('maps only inline Vor comments to prior threads and preserves pushback', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/comments?')) {
        return jsonResponse({
          values: [
            { id: 1, content: { raw: `${AGENT_REVIEW_MARKER}\n\nsummary` } },
            {
              id: 2,
              content: { raw: `${AGENT_REVIEW_MARKER}\n\n**[IMPORTANT · bug]** Null crash` },
              inline: { path: 'src/app.ts', to: 5 },
            },
            {
              id: 3,
              parent: { id: 2 },
              user: { nickname: 'author' },
              content: { raw: "> quoted finding\n\nThis is by design; won't fix." },
            },
            {
              id: 4,
              content: { raw: `${AGENT_REVIEW_MARKER}\n\n**[MINOR · docs]** Old note` },
              inline: { path: 'README.md', from: 9 },
              resolution: { type: 'RESOLVED' },
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const platform = createBitbucketPlatform({
      workspace: 'ws',
      repoSlug: 'repo',
      pullRequestId: 3,
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(platform.fetchPriorReviewThreads(emptyContext())).resolves.toEqual([
      expect.objectContaining({
        file_path: 'src/app.ts',
        line: 5,
        from_dismissable_review: true,
        already_dismissed: false,
        has_pushback: true,
        replies: [{ author: 'author', excerpt: "This is by design; won't fix." }],
      }),
      expect.objectContaining({
        file_path: 'README.md',
        line: 9,
        from_dismissable_review: false,
        already_dismissed: true,
      }),
    ]);
  });

  it('continues sticky cleanup after one inline comment fails to resolve', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? 'GET'} ${href}`);
      if (href.includes('/comments?')) {
        return jsonResponse({
          values: [10, 11].map((id) => ({
            id,
            content: { raw: `${AGENT_REVIEW_MARKER}\n\nfinding ${id}` },
            inline: { path: 'src/app.ts', to: id },
          })),
        });
      }
      if (href.endsWith('/comments/10/resolve')) return jsonResponse({ error: 'failed' }, 500);
      if (href.endsWith('/comments/11/resolve')) return new Response(null, { status: 204 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected URL ${href}`);
    });
    const platform = createBitbucketPlatform({
      workspace: 'ws',
      repoSlug: 'repo',
      pullRequestId: 3,
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(platform.supersedePriorReviews(emptyContext())).resolves.toBe(1);
    expect(calls.some((call) => call.endsWith('/comments/11/resolve'))).toBe(true);
  });
});
