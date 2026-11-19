import { describe, expect, it, vi } from 'vitest';
import { BitbucketApiError } from '../util/errors.js';
import { BitbucketClient } from './client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BitbucketClient', () => {
  it('rejects invalid or credential-bearing API base URLs', () => {
    const base = {
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
    };
    expect(() => new BitbucketClient({ ...base, apiBaseUrl: 'not-a-url' })).toThrow(
      'Invalid Bitbucket API base URL',
    );
    expect(
      () => new BitbucketClient({ ...base, apiBaseUrl: 'https://user:pass@example.com/2.0' }),
    ).toThrow('Invalid Bitbucket API base URL');
    expect(() => new BitbucketClient({ ...base, apiBaseUrl: 'file:///tmp/api' })).toThrow(
      'Invalid Bitbucket API base URL',
    );
    expect(() => new BitbucketClient({ ...base, apiBaseUrl: 'http://example.com/2.0' })).toThrow(
      'Invalid Bitbucket API base URL',
    );
    expect(
      () => new BitbucketClient({ ...base, apiBaseUrl: 'http://127.0.0.1:8080/2.0' }),
    ).not.toThrow();
    expect(
      () => new BitbucketClient({ ...base, apiBaseUrl: 'https://example.com/?page=1' }),
    ).toThrow('Invalid Bitbucket API base URL');
  });

  it('authenticates, paginates, and posts inline comments', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/diffstat') && href.includes('page=2')) {
        return jsonResponse({ values: [{ status: 'modified', lines_added: 2 }] });
      }
      if (href.includes('/diffstat')) {
        return jsonResponse({
          values: [{ status: 'added', lines_added: 1 }],
          next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/diffstat?page=2',
        });
      }
      if (href.endsWith('/comments')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          content: { raw: 'body' },
          inline: { path: 'src/app.ts', to: 5, start_to: 4 },
        });
        return jsonResponse({ id: 99 });
      }
      throw new Error(`unexpected URL ${href}`);
    });

    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listDiffStat(7)).resolves.toEqual([
      { status: 'added', lines_added: 1 },
      { status: 'modified', lines_added: 2 },
    ]);
    await expect(
      client.createComment(7, {
        body: 'body',
        inline: { path: 'src/app.ts', line: 5, startLine: 4, side: 'RIGHT' },
      }),
    ).resolves.toEqual({ id: 99 });

    const firstHeaders = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe(
      `Basic ${Buffer.from('bot@example.com:token123').toString('base64')}`,
    );
  });

  it('returns null for missing source files', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'missing' }, 404));
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readSource('abc123', 'missing.ts')).resolves.toBeNull();
  });

  it('reads source bytes and encodes each path segment', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://api.bitbucket.org/2.0/repositories/ws/repo/src/abc123/src/a%20file.ts',
      );
      expect((init?.headers as Record<string, string>).Accept).toBe('application/octet-stream');
      return new Response(new Uint8Array([0, 1, 2, 255]));
    });
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.readSource('abc123', 'src/a file.ts')).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
  });

  it('posts global and left-side comments and updates review state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (String(url).endsWith('/resolve')) return new Response(null, { status: 204 });
      return jsonResponse({ id: 9 });
    });
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.createComment(7, { body: 'summary' });
    await client.createComment(7, {
      body: 'removed line',
      inline: { path: 'src/app.ts', line: 8, startLine: 7, side: 'LEFT' },
    });
    await client.resolveComment(7, 9);
    await client.approve(7);
    await client.unapprove(7);
    await client.requestChanges(7);
    await client.removeChangeRequest(7);

    const commentBodies = calls
      .filter((call) => call.url.endsWith('/comments'))
      .map((call) => JSON.parse(String(call.init?.body)));
    expect(commentBodies).toEqual([
      { content: { raw: 'summary' } },
      {
        content: { raw: 'removed line' },
        inline: { path: 'src/app.ts', from: 8, start_from: 7 },
      },
    ]);
    expect(calls.map((call) => [call.init?.method ?? 'GET', call.url])).toEqual(
      expect.arrayContaining([
        ['POST', expect.stringMatching(/\/comments\/9\/resolve$/)],
        ['POST', expect.stringMatching(/\/approve$/)],
        ['DELETE', expect.stringMatching(/\/approve$/)],
        ['POST', expect.stringMatching(/\/request-changes$/)],
        ['DELETE', expect.stringMatching(/\/request-changes$/)],
      ]),
    );
  });

  it('refuses cross-origin pagination without forwarding credentials', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        values: [],
        next: 'https://attacker.example/steal',
      }),
    );
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listComments(7)).rejects.toThrow(
      /Refusing to send Bitbucket credentials to pagination origin/,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects repeated pagination URLs instead of looping', async () => {
    const next =
      'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/comments?pagelen=100';
    const fetchImpl = vi.fn(async () => jsonResponse({ values: [], next }));
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listComments(7)).rejects.toThrow(/pagination repeated URL/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not retry a mutating request that returns a conflict', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'conflict' }, 409));
    const client = new BitbucketClient({
      workspace: 'ws',
      repoSlug: 'repo',
      email: 'bot@example.com',
      apiToken: 'token123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.resolveComment(7, 9)).rejects.toBeInstanceOf(BitbucketApiError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
