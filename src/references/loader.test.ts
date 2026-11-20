import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { FileReader } from '../github/file-reader.js';
import { loadReferences } from './loader.js';

describe('loadReferences', () => {
  it('loads repo globs, caches on disk, and splits inline vs on-demand on budget overflow', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-cache-'));
    try {
      mkdirSync(join(ws, 'docs/adr'), { recursive: true });
      writeFileSync(join(ws, 'docs/adr/001.md'), '# ADR 001\nUse ports and adapters.\n');
      writeFileSync(join(ws, 'docs/adr/002.md'), `# ADR 002\n${'x'.repeat(200)}\n`);

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        max_inline_bytes: 60,
        sources: ['docs/adr/**/*.md'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      const first = await loadReferences({ config, workspaceDir: ws });
      expect(first.docs).toHaveLength(2);
      expect(first.inline_docs.map((d) => d.id)).toEqual(['docs/adr/001.md']);
      expect(first.on_demand_docs.map((d) => d.id)).toEqual(['docs/adr/002.md']);
      expect(first.cache_stats.misses).toBe(2);

      // Second load hits disk cache with matching source_fingerprint
      const second = await loadReferences({ config, workspaceDir: ws });
      expect(second.cache_stats.hits).toBe(2);
      expect(second.corpus_digest).toBe(first.corpus_digest);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('caches remote URLs with TTL, revalidates via ETag 304, and falls back to stale on error', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-url-'));
    try {
      let mode: 'initial' | '304' | 'fail' = 'initial';
      const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (mode === 'initial') {
          return new Response('<h1>Remote Standard</h1><p>Validate inputs.</p>', {
            status: 200,
            headers: {
              'content-type': 'text/html',
              etag: '"v1"',
            },
          });
        }
        if (mode === '304') {
          const hdrs = init?.headers as Record<string, string>;
          expect(hdrs['If-None-Match']).toBe('"v1"');
          return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        }
        throw new Error('network down');
      });

      const baseCfg = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: [{ id: 'sec', url: 'https://standards.example.com/security.html' }],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir, ttl_seconds: 60 },
      };

      const t0 = Date.parse('2026-11-20T12:00:00.000Z');
      const r1 = await loadReferences({
        config: baseCfg,
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowMs: t0,
      });
      expect(r1.docs).toHaveLength(1);
      expect(r1.docs[0]?.content).toContain('# Remote Standard');
      expect(r1.cache_stats.misses).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Within TTL: zero network calls
      const r2 = await loadReferences({
        config: baseCfg,
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowMs: t0 + 10_000,
      });
      expect(r2.cache_stats.hits).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Past TTL: conditional 304 revalidation
      mode = '304';
      const r3 = await loadReferences({
        config: baseCfg,
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowMs: t0 + 120_000,
      });
      expect(r3.cache_stats.revalidated).toBe(1);
      expect(r3.docs[0]?.content).toContain('# Remote Standard');

      // Past TTL + network failure: stale_on_error fallback
      mode = 'fail';
      const r4 = await loadReferences({
        config: baseCfg,
        fetchImpl: fetchSpy as unknown as typeof fetch,
        nowMs: t0 + 300_000,
      });
      expect(r4.cache_stats.stale_fallbacks).toBe(1);
      expect(r4.docs[0]?.content).toContain('# Remote Standard');
      expect(r4.warnings[0]).toContain('using stale cached copy');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('rejects cloud metadata URLs and escaping workspace paths', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-sec-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-sec-cache-'));
    try {
      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['http://169.254.169.254/latest/meta-data', '../outside.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
      });
      expect(res.docs).toEqual([]);
      expect(res.warnings).toHaveLength(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('fetches and caches cross-repo GitHub references', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-gh-'));
    try {
      const getContent = vi.fn(async () => ({
        data: {
          type: 'file',
          sha: 'blob123',
          content: Buffer.from('# Org DDD Rules\nUse aggregates.\n', 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      }));
      const octokit = { rest: { repos: { getContent } } } as unknown as NonNullable<
        Parameters<typeof loadReferences>[0]['octokit']
      >;

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: ['github:acme/standards/docs/ddd.md@main'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      const first = await loadReferences({ config, octokit });
      expect(first.docs).toHaveLength(1);
      expect(first.docs[0]?.kind).toBe('github');
      expect(first.cache_stats.misses).toBe(1);
      expect(getContent).toHaveBeenCalledTimes(1);

      const second = await loadReferences({ config, octokit });
      expect(second.cache_stats.hits).toBe(1);
      expect(getContent).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked reference files and symlinked parent directories escaping workspaceDir', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-sym-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'vor-refs-sym-out-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-sym-cache-'));
    try {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(outside, 'secret.md'), '# Secret\nTOP_SECRET_VALUE\n');
      symlinkSync(join(outside, 'secret.md'), join(ws, 'docs/leak-file.md'));
      symlinkSync(outside, join(ws, 'docs/ext'));

      const readSpy = vi.fn(async () => '# From API\nshould not run\n');
      const fileReader = { read: readSpy } as unknown as FileReader;

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['docs/leak-file.md', 'docs/ext/secret.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
        owner: 'acme',
        repo: 'svc',
        ref: 'sha1',
        fileReader,
      });

      expect(res.docs).toEqual([]);
      expect(res.warnings).toHaveLength(2);
      expect(res.warnings[0]).toContain('symlink');
      expect(res.warnings[1]).toContain('symlink');
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('blocks private/loopback/IPv6 URLs and validates redirect destinations before following', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-ssrf-'));
    try {
      const blockedUrls = [
        'http://127.0.0.1/secret',
        'http://10.0.0.1/secret',
        'http://172.16.5.4/secret',
        'http://192.168.1.1/secret',
        'http://localhost/secret',
        'http://[::1]/secret',
        'http://[fe80::1]/secret',
        'http://[::ffff:169.254.169.254]/latest/meta-data',
      ];
      const blockedFetch = vi.fn(async () => new Response('nope', { status: 200 }));
      const blockedRes = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: blockedUrls,
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        fetchImpl: blockedFetch as unknown as typeof fetch,
      });
      expect(blockedRes.docs).toEqual([]);
      expect(blockedRes.warnings).toHaveLength(blockedUrls.length);
      expect(blockedFetch).not.toHaveBeenCalled();

      // Redirect to metadata IP must be blocked before fetching the redirect target.
      const seenTargets: string[] = [];
      const redirectFetch = vi.fn(async (target: string | URL | Request) => {
        const u = String(target);
        seenTargets.push(u);
        if (u === 'https://standards.example.com/bad-redirect') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          });
        }
        if (u === 'https://standards.example.com/good-redirect') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://standards.example.com/final.md' },
          });
        }
        if (u === 'https://standards.example.com/final.md') {
          return new Response('# Redirected Standard\nOK\n', { status: 200 });
        }
        throw new Error(`Unexpected fetch to ${u}`);
      });

      const redirRes = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: [
            'https://standards.example.com/bad-redirect',
            'https://standards.example.com/good-redirect',
          ],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        fetchImpl: redirectFetch as unknown as typeof fetch,
      });
      expect(seenTargets).not.toContain('http://169.254.169.254/latest/meta-data');
      expect(redirRes.docs).toHaveLength(1);
      expect(redirRes.docs[0]?.content).toContain('# Redirected Standard');
      expect(redirRes.warnings.some((w) => w.includes('Blocked host'))).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('keys cached repo docs by requested ref so an unchanged checkout cannot serve stale PR standards', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-refkey-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-refkey-cache-'));
    try {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(ws, 'docs/std.md'), '# Checkout Copy\nLocal checkout.\n');

      const readSpy = vi.fn(
        async ({ ref }: { ref: string }) => `# Standard @ ${ref}\nRule for ${ref}.\n`,
      );
      const fileReader = { read: readSpy } as unknown as FileReader;

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: ['docs/std.md'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      const r1 = await loadReferences({
        config,
        workspaceDir: ws,
        owner: 'acme',
        repo: 'svc',
        ref: 'sha-1',
        fileReader,
      });
      expect(r1.docs[0]?.content).toContain('Standard @ sha-1');
      expect(readSpy).toHaveBeenCalledTimes(1);

      const r2 = await loadReferences({
        config,
        workspaceDir: ws,
        owner: 'acme',
        repo: 'svc',
        ref: 'sha-2',
        fileReader,
      });
      expect(r2.docs[0]?.content).toContain('Standard @ sha-2');
      expect(readSpy).toHaveBeenCalledTimes(2);

      // Repeat for sha-1 hits sha-1's cached ref entry without re-fetching.
      const r1Repeat = await loadReferences({
        config,
        workspaceDir: ws,
        owner: 'acme',
        repo: 'svc',
        ref: 'sha-1',
        fileReader,
      });
      expect(r1Repeat.cache_stats.hits).toBe(1);
      expect(r1Repeat.docs[0]?.content).toContain('Standard @ sha-1');
      expect(readSpy).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('cancels oversized streamed responses at the 5 MB cap and warns on truncated GitHub trees', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-stream-'));
    try {
      let pulls = 0;
      let canceled = false;
      const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MB of 'a'
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      const bigFetch = vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      const getTree = vi.fn(async () => ({
        data: {
          truncated: true,
          tree: [{ type: 'blob', path: 'docs/a.md' }],
        },
      }));
      const getContent = vi.fn(async () => ({
        data: {
          type: 'file',
          sha: 'blob-a',
          content: Buffer.from('# Doc A\nHello.\n', 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      }));
      const octokit = {
        rest: { git: { getTree }, repos: { getContent } },
      } as unknown as NonNullable<Parameters<typeof loadReferences>[0]['octokit']>;

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['https://standards.example.com/huge.txt', 'github:acme/std/docs/*.md@main'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        fetchImpl: bigFetch as unknown as typeof fetch,
        octokit,
      });

      expect(canceled).toBe(true);
      expect(pulls).toBeLessThanOrEqual(6);
      expect(res.docs).toHaveLength(2);
      expect(res.warnings.some((w) => w.includes('truncated'))).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
