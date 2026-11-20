import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
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
});
