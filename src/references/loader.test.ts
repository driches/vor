import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { FileReader } from '../github/file-reader.js';
import { DiskReferenceCache } from './cache.js';
import { type LoadReferencesInput, loadReferences, pinnedNodeFetch } from './loader.js';

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

  it('expands repo reference globs against PR HEAD via git.getTree even when workspaceDir has a partial subset', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-glob-head-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-glob-head-cache-'));
    try {
      mkdirSync(join(ws, 'docs/adr'), { recursive: true });
      writeFileSync(join(ws, 'docs/adr/001.md'), '# ADR 001\nBase doc.\n');

      const getTree = vi.fn(async () => ({
        data: {
          truncated: false,
          tree: [
            { type: 'blob', path: 'docs/adr/001.md' },
            { type: 'blob', path: 'docs/adr/002.md' },
          ],
        },
      }));
      const octokit = { rest: { git: { getTree } } } as unknown as NonNullable<
        Parameters<typeof loadReferences>[0]['octokit']
      >;
      const fileReader = {
        read: vi.fn(async ({ path }: { path: string }) =>
          path === 'docs/adr/002.md' ? '# ADR 002\nAdded in PR HEAD.\n' : '# ADR 001\nBase doc.\n',
        ),
      } as unknown as FileReader;

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['docs/adr/**/*.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
        owner: 'acme',
        repo: 'svc',
        ref: 'head-sha',
        fileReader,
        octokit,
      });

      expect(getTree).toHaveBeenCalledTimes(1);
      expect(res.docs.map((d) => d.id)).toEqual(['docs/adr/001.md', 'docs/adr/002.md']);
      expect(res.docs[1]?.content).toContain('Added in PR HEAD.');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('re-applies max_doc_bytes on cache hits without serving stale truncation', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-cap-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-cap-cache-'));
    try {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      const longBody = `# Big Standard\n${'word '.repeat(600)}\n`;
      writeFileSync(join(ws, 'docs/big.md'), longBody);

      const rSmall = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          max_doc_bytes: 100,
          sources: ['docs/big.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
      });
      expect(rSmall.docs[0]?.truncated).toBe(true);
      expect(rSmall.docs[0]!.byte_length).toBeLessThanOrEqual(100);

      // Raising max_doc_bytes hits cache while surfacing the full untruncated doc.
      const rLarge = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          max_doc_bytes: 10_000,
          sources: ['docs/big.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
      });
      expect(rLarge.cache_stats.hits).toBe(1);
      expect(rLarge.docs[0]?.truncated).toBe(false);
      expect(rLarge.docs[0]!.byte_length).toBeGreaterThan(2000);

      // Lowering max_doc_bytes again enforces the new smaller cap on cache hit.
      const rTiny = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          max_doc_bytes: 50,
          sources: ['docs/big.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
      });
      expect(rTiny.cache_stats.hits).toBe(1);
      expect(rTiny.docs[0]?.truncated).toBe(true);
      expect(rTiny.docs[0]!.byte_length).toBeLessThanOrEqual(50);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('parses GitHub refs containing slashes for both string and object sources while preserving scoped paths', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-gh-slash-'));
    try {
      const getContent = vi.fn(async ({ path, ref }: { path: string; ref: string }) => ({
        data: {
          type: 'file',
          sha: `${ref}:${path}`,
          content: Buffer.from(`# Doc\nFrom ${path} @ ${ref}\n`, 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      }));
      // Narrow Octokit mock provides only `rest.repos.getContent` exercised by `loadGithubFile`.
      const octokit = {
        rest: { repos: { getContent } },
      } as unknown as NonNullable<Parameters<typeof loadReferences>[0]['octokit']>;

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: [
            'github:acme/standards/docs/style.md@feature/new-rules',
            { github: 'acme/standards/docs/arch.md@release/v2.0', id: 'arch-obj' },
            'github:acme/standards/packages/@scope/README.md',
          ],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        octokit,
      });

      expect(res.warnings).toEqual([]);
      expect(res.docs).toHaveLength(3);
      expect(getContent).toHaveBeenNthCalledWith(1, {
        owner: 'acme',
        repo: 'standards',
        path: 'docs/style.md',
        ref: 'feature/new-rules',
      });
      expect(getContent).toHaveBeenNthCalledWith(2, {
        owner: 'acme',
        repo: 'standards',
        path: 'docs/arch.md',
        ref: 'release/v2.0',
      });
      expect(getContent).toHaveBeenNthCalledWith(3, {
        owner: 'acme',
        repo: 'standards',
        path: 'packages/@scope/README.md',
        ref: 'HEAD',
      });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('blocks DNS resolutions to private/metadata IPs on initial URLs and redirect hops', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-dns-ssrf-'));
    try {
      // No `fetchImpl` is injected for the direct private DNS check, verifying live transport
      // rejects before opening any socket when DNS returns restricted or mixed addresses.
      const lookupImpl = vi.fn(async (host: string) => {
        if (host === 'rebind-loopback.example') {
          return [{ address: '127.0.0.1', family: 4 as const }];
        }
        if (host === 'rebind-meta.example') {
          return [{ address: '::ffff:169.254.169.254', family: 6 as const }];
        }
        if (host === 'rebind-nat64.example') {
          return [{ address: '64:ff9b::169.254.169.254', family: 6 as const }];
        }
        if (host === 'mixed-dual.example') {
          return [
            { address: '93.184.216.34', family: 4 as const },
            { address: '10.0.0.5', family: 4 as const },
          ];
        }
        if (host === 'pub-start.example') {
          return [{ address: '93.184.216.34', family: 4 as const }];
        }
        if (host === 'priv-hop.example') {
          return [{ address: '10.0.0.2', family: 4 as const }];
        }
        return [{ address: '93.184.216.34', family: 4 as const }];
      });

      const directBlocked = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: [
            'https://rebind-loopback.example/a.md',
            'https://rebind-meta.example/b.md',
            'https://rebind-nat64.example/c.md',
            'https://mixed-dual.example/d.md',
          ],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        lookupImpl,
      });

      expect(directBlocked.docs).toEqual([]);
      expect(directBlocked.warnings).toHaveLength(4);
      expect(directBlocked.warnings.every((w) => w.includes('Blocked host'))).toBe(true);

      const seenTargets: string[] = [];
      const redirectFetch = vi.fn(async (target: string | URL | Request) => {
        const u = String(target);
        seenTargets.push(u);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://priv-hop.example/internal.md' },
        });
      });

      const redirBlocked = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['https://pub-start.example/start.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        lookupImpl,
        // Narrow fetch stub mirrors Web `fetch` signature to observe redirect target requests.
        fetchImpl: redirectFetch as unknown as typeof fetch,
      });

      expect(seenTargets).toEqual(['https://pub-start.example/start.md']);
      expect(redirBlocked.docs).toEqual([]);
      expect(redirBlocked.warnings.some((w) => w.includes('Blocked host'))).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('pins HTTP socket connection to validated address and handles text, gzip, 304, and 302 responses', async () => {
    let seenHostHeader = '';
    const server = createServer((req, res) => {
      seenHostHeader = req.headers.host ?? '';
      if (req.url === '/std.md') {
        res.writeHead(200, { 'content-type': 'text/markdown', etag: '"v1"' });
        res.end('# Pinned\nHello pinned world.\n');
        return;
      }
      if (req.url === '/gzip.md') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.from('compressed-ok', 'utf-8')));
        return;
      }
      if (req.url === '/not-mod') {
        res.writeHead(304, { etag: '"v2"' });
        res.end();
        return;
      }
      res.writeHead(302, { location: '/std.md' });
      res.end();
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => resolvePromise());
    });

    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Expected TCP server address');
      }
      const controller = new AbortController();
      const pinned = [{ address: '127.0.0.1', family: 4 as const }];

      const okRes = await pinnedNodeFetch(
        new URL(`http://pinned.example.test:${addr.port}/std.md`),
        pinned,
        { 'User-Agent': 'vor-test' },
        controller.signal,
      );
      expect(okRes.status).toBe(200);
      expect(okRes.ok).toBe(true);
      expect(okRes.headers.get('etag')).toBe('"v1"');
      expect(seenHostHeader).toBe(`pinned.example.test:${addr.port}`);
      expect(await new Response(okRes.body).text()).toBe('# Pinned\nHello pinned world.\n');

      const gzRes = await pinnedNodeFetch(
        new URL(`http://pinned.example.test:${addr.port}/gzip.md`),
        pinned,
        {},
        controller.signal,
      );
      expect(await new Response(gzRes.body).text()).toBe('compressed-ok');

      const notModRes = await pinnedNodeFetch(
        new URL(`http://pinned.example.test:${addr.port}/not-mod`),
        pinned,
        {},
        controller.signal,
      );
      expect(notModRes.status).toBe(304);
      expect(notModRes.body).toBeNull();

      const redirRes = await pinnedNodeFetch(
        new URL(`http://pinned.example.test:${addr.port}/redir`),
        pinned,
        {},
        controller.signal,
      );
      expect(redirRes.status).toBe(302);
      expect(redirRes.headers.get('location')).toBe('/std.md');
      expect(redirRes.body).toBeNull();
    } finally {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    }
  });

  it('isolates local disk reference cache entries across workspaces even when size and mtime match', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'vor-refs-iso-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'vor-refs-iso-b-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-iso-cache-'));
    try {
      const fileA = join(wsA, 'docs.md');
      const fileB = join(wsB, 'docs.md');
      // Exact equal byte lengths and identical mtimes across separate workspaces.
      writeFileSync(fileA, '# Workspace Alpha\nAlways enforce A.\n');
      writeFileSync(fileB, '# Workspace Bravo\nAlways enforce B.\n');
      const sharedTime = new Date('2026-01-15T12:00:00Z');
      utimesSync(fileA, sharedTime, sharedTime);
      utimesSync(fileB, sharedTime, sharedTime);

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: ['docs.md'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      const resA = await loadReferences({ config, workspaceDir: wsA });
      expect(resA.cache_stats.misses).toBe(1);
      expect(resA.docs[0]?.content).toContain('Workspace Alpha');

      const resB = await loadReferences({ config, workspaceDir: wsB });
      expect(resB.cache_stats.misses).toBe(1);
      expect(resB.docs[0]?.content).toContain('Workspace Bravo');
      expect(resB.docs[0]?.content).not.toContain('Workspace Alpha');

      const resARepeat = await loadReferences({ config, workspaceDir: wsA });
      expect(resARepeat.cache_stats.hits).toBe(1);
      expect(resARepeat.docs[0]?.content).toContain('Workspace Alpha');
    } finally {
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('degrades cache write failures to uncached docs with warnings instead of throwing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-unwritable-ws-'));
    try {
      writeFileSync(join(ws, 'docs.md'), '# Uncached Standard\nMust still load.\n');
      const blockingCachePath = join(ws, '.cache-blocker');
      writeFileSync(blockingCachePath, 'file-blocks-mkdir', 'utf-8');

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['docs.md'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: '.cache-blocker' },
        },
        workspaceDir: ws,
      });

      expect(res.docs).toHaveLength(1);
      expect(res.docs[0]?.content).toContain('Must still load.');
      expect(res.docs[0]?.cache_status).toBe('uncached');
      expect(res.cache_stats.uncached).toBe(1);
      expect(res.warnings.some((w) => w.includes('Could not persist reference'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to git.getBlob when GitHub Contents API returns encoding "none" for >1 MB files', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-largeblob-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-largeblob-cache-'));
    try {
      const largeBody = `# Large Spec\n\n${'word '.repeat(500)}`;
      const getContent = vi.fn(async () => ({
        data: {
          type: 'file',
          sha: 'largeblob1',
          encoding: 'none',
          content: '',
          size: 1_500_000,
        },
        headers: { etag: '"etag-large"' },
      }));
      const getBlob = vi.fn(async () => ({
        data: {
          sha: 'largeblob1',
          encoding: 'base64',
          content: Buffer.from(largeBody, 'utf-8').toString('base64'),
        },
      }));
      const octokit = {
        rest: {
          repos: { getContent },
          git: { getBlob },
        },
      } as unknown as LoadReferencesInput['octokit'];

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          max_doc_bytes: 200,
          sources: ['github:acme/standards/docs/large-spec.md@main'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
        octokit,
      });

      expect(getBlob).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'standards',
        file_sha: 'largeblob1',
      });
      expect(res.warnings).toEqual([]);
      expect(res.docs).toHaveLength(1);
      expect(res.docs[0]?.truncated).toBe(true);
      expect(Buffer.byteLength(res.docs[0]!.content, 'utf-8')).toBeLessThanOrEqual(200);
      expect(res.docs[0]?.content).toContain('# Large Spec');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('revalidates url and github cache entries when ttl_seconds is lowered below stored TTL', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-ttl-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-ttl-cache-'));
    try {
      const nowMs = Date.parse('2026-02-01T12:00:00Z');
      const lookupImpl: LoadReferencesInput['lookupImpl'] = async () => [
        { address: '93.184.216.34', family: 4 as const },
      ];

      // 1. Seed URL cache entry with 24h TTL, then lower to 0s with stale_on_error: false.
      const urlFetchOk: LoadReferencesInput['fetchImpl'] = async () =>
        new Response('# Remote V1', { status: 200, headers: { 'content-type': 'text/markdown' } });
      const firstUrl = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['https://example.com/guide.md'],
          cache: {
            ...DEFAULT_CONFIG.references.cache,
            dir: cacheDir,
            ttl_seconds: 86_400,
            stale_on_error: false,
          },
        },
        workspaceDir: ws,
        nowMs,
        fetchImpl: urlFetchOk,
        lookupImpl,
      });
      expect(firstUrl.docs[0]?.cache_status).toBe('miss');

      const urlFetchFail = vi.fn(async () => new Response('down', { status: 503 }));
      const loweredUrlFail = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['https://example.com/guide.md'],
          cache: {
            ...DEFAULT_CONFIG.references.cache,
            dir: cacheDir,
            ttl_seconds: 0,
            stale_on_error: false,
          },
        },
        workspaceDir: ws,
        nowMs: nowMs + 1_000,
        fetchImpl: urlFetchFail,
        lookupImpl,
      });
      expect(urlFetchFail).toHaveBeenCalledTimes(1);
      expect(loweredUrlFail.docs).toEqual([]);
      expect(loweredUrlFail.cache_stats.hits).toBe(0);

      // 2. Seed GitHub cache entry with 24h TTL, then lower source ttl_seconds to 0.
      const getContent = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            sha: 'sha1',
            encoding: 'base64',
            content: Buffer.from('# GitHub V1', 'utf-8').toString('base64'),
          },
          headers: { etag: '"e1"' },
        })
        .mockResolvedValueOnce({
          data: {
            type: 'file',
            sha: 'sha2',
            encoding: 'base64',
            content: Buffer.from('# GitHub V2', 'utf-8').toString('base64'),
          },
          headers: { etag: '"e2"' },
        });
      const octokit = {
        rest: { repos: { getContent } },
      } as unknown as LoadReferencesInput['octokit'];

      const firstGh = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: ['github:acme/standards/docs/style.md@main'],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir, ttl_seconds: 86_400 },
        },
        workspaceDir: ws,
        nowMs,
        octokit,
      });
      expect(firstGh.docs[0]?.content).toBe('# GitHub V1');

      const loweredGh = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: [
            {
              github: 'acme/standards/docs/style.md@main',
              ttl_seconds: 0,
            },
          ],
          cache: {
            ...DEFAULT_CONFIG.references.cache,
            dir: cacheDir,
            ttl_seconds: 86_400,
            stale_on_error: false,
          },
        },
        workspaceDir: ws,
        nowMs: nowMs + 1_000,
        octokit,
      });
      expect(getContent).toHaveBeenCalledTimes(2);
      expect(loweredGh.docs[0]?.content).toBe('# GitHub V2');
      expect(loweredGh.cache_stats.hits).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('reserves configured IDs before assigning duplicate suffixes so guide/guide/guide-2 stay unique', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-id-reserve-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-id-reserve-cache-'));
    try {
      writeFileSync(join(ws, 'a.md'), '# Alpha\n');
      writeFileSync(join(ws, 'b.md'), '# Beta\n');
      writeFileSync(join(ws, 'c.md'), '# Gamma\n');

      const res = await loadReferences({
        config: {
          ...DEFAULT_CONFIG.references,
          enabled: true,
          sources: [
            { path: 'a.md', id: 'guide' },
            { path: 'b.md', id: 'guide' },
            { path: 'c.md', id: 'guide-2' },
          ],
          cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
        },
        workspaceDir: ws,
      });

      expect(res.docs.map((d) => d.id)).toEqual(['guide', 'guide-3', 'guide-2']);
      expect(res.docs.find((d) => d.id === 'guide')?.content).toContain('# Alpha');
      expect(res.docs.find((d) => d.id === 'guide-3')?.content).toContain('# Beta');
      expect(res.docs.find((d) => d.id === 'guide-2')?.content).toContain('# Gamma');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('uses githubOctokit for cross-repo sources while keeping local octokit/workspaceDir for repo globs', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-refs-split-client-ws-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-split-client-cache-'));
    try {
      mkdirSync(join(ws, 'docs'), { recursive: true });
      writeFileSync(join(ws, 'docs/style.md'), '# Local Style\nLocal workspace doc.\n');
      writeFileSync(join(ws, 'docs/local-extra.md'), '# Local Extra\nFrom workspace.\n');

      const localGetContent = vi.fn(async () => ({
        data: {
          type: 'file',
          sha: 'local-sha',
          content: Buffer.from('# Local Fake GetContent\n', 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      }));
      const localOctokit = {
        rest: { repos: { getContent: localGetContent } },
      } as unknown as NonNullable<LoadReferencesInput['octokit']>;

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: ['docs/*.md', 'github:org/standards/docs/style.md@HEAD'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      // With githubOctokit: null, cross-repo source must neither call localOctokit nor poison the remote cache key.
      const unauthRes = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: ws,
        octokit: localOctokit,
        githubOctokit: null,
      });
      expect(localGetContent).not.toHaveBeenCalled();
      expect(unauthRes.docs.map((d) => d.source)).toEqual(['docs/local-extra.md', 'docs/style.md']);
      expect(
        unauthRes.warnings.some((w) => w.includes('github:org/standards/docs/style.md@HEAD')),
      ).toBe(true);
      const diskCache = new DiskReferenceCache(cacheDir);
      expect(
        diskCache.get('github:org/standards@HEAD:docs/style.md', Date.now(), 86_400).status,
      ).toBe('miss');

      // With an explicit remote githubOctokit, both single-file and glob github: sources use remoteOctokit
      // while repo globs still enumerate workspaceDir rather than calling remoteOctokit.rest.git.getTree for local/local.
      const remoteGetContent = vi.fn(
        async (args: { owner: string; repo: string; path: string }) => ({
          data: {
            type: 'file',
            sha: `remote-${args.path}`,
            content: Buffer.from(
              `# Remote ${args.owner}/${args.repo}/${args.path}\n`,
              'utf-8',
            ).toString('base64'),
            encoding: 'base64',
          },
        }),
      );
      const remoteGetTree = vi.fn(async () => ({
        data: {
          truncated: false,
          tree: [{ type: 'blob', path: 'rules/security.md' }],
        },
      }));
      const remoteOctokit = {
        rest: {
          repos: { getContent: remoteGetContent },
          git: { getTree: remoteGetTree },
        },
      } as unknown as NonNullable<LoadReferencesInput['octokit']>;

      const authRes = await loadReferences({
        config: {
          ...config,
          sources: [
            'docs/*.md',
            'github:org/standards/docs/style.md@HEAD',
            'github:org/standards/rules/*.md@main',
          ],
        },
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: ws,
        octokit: localOctokit,
        githubOctokit: remoteOctokit,
      });
      expect(localGetContent).not.toHaveBeenCalled();
      expect(remoteGetTree).toHaveBeenCalledTimes(1);
      expect(remoteGetTree).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'org', repo: 'standards', tree_sha: 'main' }),
      );
      expect(remoteGetContent).toHaveBeenCalledTimes(2);
      expect(authRes.docs.find((d) => d.source === 'docs/style.md')?.content).toContain(
        'Local workspace doc.',
      );
      expect(
        authRes.docs.find((d) => d.source === 'github:org/standards/docs/style.md@HEAD')?.content,
      ).toContain('Remote org/standards/docs/style.md');
      expect(
        authRes.docs.find((d) => d.source === 'github:org/standards/rules/security.md@main')
          ?.content,
      ).toContain('Remote org/standards/rules/security.md');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('invalidates WORKTREE reference cache on local edits and isolates workspaces sharing a cache', async () => {
    const wsA = mkdtempSync(join(tmpdir(), 'vor-refs-worktree-a-'));
    const wsB = mkdtempSync(join(tmpdir(), 'vor-refs-worktree-b-'));
    const cacheDir = mkdtempSync(join(tmpdir(), 'vor-refs-worktree-cache-'));
    try {
      mkdirSync(join(wsA, 'docs'), { recursive: true });
      mkdirSync(join(wsB, 'docs'), { recursive: true });
      const fileA = join(wsA, 'docs/standards.md');
      const fileB = join(wsB, 'docs/standards.md');
      // Identical byte length across edits/workspaces tests content-sha invalidation + key isolation.
      writeFileSync(fileA, '# Standard V1\nAlways enforce A.\n');
      writeFileSync(fileB, '# Workspace B\nAlways enforce B.\n');
      const sharedTime = new Date('2026-01-15T12:00:00Z');
      utimesSync(fileA, sharedTime, sharedTime);
      utimesSync(fileB, sharedTime, sharedTime);

      const makeLocalReader = (ws: string) => {
        const read = vi.fn(async ({ path }: { path: string }) => {
          return readFileSync(join(ws, path), 'utf-8');
        });
        return {
          read,
          reader: { read } as unknown as FileReader,
        };
      };

      const config = {
        ...DEFAULT_CONFIG.references,
        enabled: true,
        sources: ['docs/standards.md'],
        cache: { ...DEFAULT_CONFIG.references.cache, dir: cacheDir },
      };

      const readerA = makeLocalReader(wsA);
      const firstA = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: wsA,
        fileReader: readerA.reader,
      });
      expect(firstA.cache_stats.misses).toBe(1);
      expect(firstA.docs[0]?.content).toContain('Standard V1');
      expect(readerA.read).toHaveBeenCalledTimes(1);

      const secondA = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: wsA,
        fileReader: readerA.reader,
      });
      expect(secondA.cache_stats.hits).toBe(1);
      expect(secondA.docs[0]?.content).toContain('Standard V1');
      expect(readerA.read).toHaveBeenCalledTimes(1);

      // Edit file in wsA with identical byte length & timestamp -> must invalidate WORKTREE cache.
      writeFileSync(fileA, '# Standard V2\nAlways enforce X.\n');
      utimesSync(fileA, sharedTime, sharedTime);

      const thirdA = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: wsA,
        fileReader: readerA.reader,
      });
      expect(thirdA.cache_stats.misses).toBe(1);
      expect(thirdA.docs[0]?.content).toContain('Standard V2');
      expect(thirdA.docs[0]?.content).not.toContain('Standard V1');
      expect(readerA.read).toHaveBeenCalledTimes(2);

      const fourthA = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: wsA,
        fileReader: readerA.reader,
      });
      expect(fourthA.cache_stats.hits).toBe(1);
      expect(fourthA.docs[0]?.content).toContain('Standard V2');
      expect(readerA.read).toHaveBeenCalledTimes(2);

      // Distinct workspace sharing cacheDir and local/local@WORKTREE sentinel stays isolated.
      const readerB = makeLocalReader(wsB);
      const firstB = await loadReferences({
        config,
        owner: 'local',
        repo: 'local',
        ref: 'WORKTREE',
        workspaceDir: wsB,
        fileReader: readerB.reader,
      });
      expect(firstB.cache_stats.misses).toBe(1);
      expect(firstB.docs[0]?.content).toContain('Workspace B');
      expect(firstB.docs[0]?.content).not.toContain('Standard V2');
    } finally {
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
