import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { FileReader } from '../github/file-reader.js';
import { loadReferences, pinnedNodeFetch } from './loader.js';

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
});
