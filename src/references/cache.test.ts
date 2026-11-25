import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiskReferenceCache,
  resolveReferenceCacheDir,
  sha256Hex,
  type ReferenceCacheMeta,
} from './cache.js';

function makeMeta(
  over: Partial<ReferenceCacheMeta> = {},
  content = 'hello world',
): ReferenceCacheMeta {
  return {
    version: 1,
    key: 'url:https://example.com/std.md',
    source_id: 'std.md',
    title: 'Standards',
    kind: 'url',
    content_sha256: sha256Hex(content),
    fetched_at: new Date('2026-11-20T12:00:00.000Z').toISOString(),
    ttl_seconds: 3600,
    byte_length: Buffer.byteLength(content, 'utf-8'),
    headings: ['Standards'],
    ...over,
  };
}

describe('DiskReferenceCache', () => {
  it('stores, hits within TTL, marks stale past TTL, touches, lists, and clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vor-ref-cache-'));
    try {
      const cache = new DiskReferenceCache(dir);
      const key = 'url:https://example.com/std.md';
      const content = '# Standards\nUse hexagonal.';
      const fetchedMs = Date.parse('2026-11-20T12:00:00.000Z');
      cache.set(key, makeMeta({ fetched_at: new Date(fetchedMs).toISOString() }, content), content);

      const hit = cache.get(key, fetchedMs + 1_000);
      expect(hit.status).toBe('hit');
      if (hit.status === 'hit') expect(hit.content).toBe(content);

      const stale = cache.get(key, fetchedMs + 4_000_000);
      expect(stale.status).toBe('stale');

      cache.touch(key, {
        fetched_at: new Date(fetchedMs + 4_000_000).toISOString(),
        etag: '"v2"',
      });
      const reHit = cache.get(key, fetchedMs + 4_001_000);
      expect(reHit.status).toBe('hit');
      if (reHit.status === 'hit') expect(reHit.meta.etag).toBe('"v2"');

      expect(cache.list()).toHaveLength(1);
      expect(cache.clear('std.md')).toBe(1);
      expect(cache.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades checksum-corrupted cache entries to miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vor-ref-corrupt-'));
    try {
      const cache = new DiskReferenceCache(dir);
      const key = 'url:https://example.com/std.md';
      cache.set(key, makeMeta({}, 'original'), 'original');
      const hash = sha256Hex(key);
      writeFileSync(join(dir, `${hash}.content`), 'tampered', 'utf-8');
      expect(cache.get(key).status).toBe('miss');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects escaping relative cache dir overrides', () => {
    const resolved = resolveReferenceCacheDir('../outside-cache', '/tmp/ws');
    expect(resolved).not.toContain('outside-cache');
  });

  it('returns false without throwing when the cache directory is not writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vor-ref-cache-file-'));
    try {
      const blockingFile = join(dir, 'not-a-directory');
      writeFileSync(blockingFile, 'occupied', 'utf-8');
      const cache = new DiskReferenceCache(blockingFile);
      expect(cache.set('url:https://example.com/std.md', makeMeta(), 'hello world')).toBe(false);
      expect(cache.list()).toEqual([]);
      expect(cache.clear()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evaluates freshness against a lowered ttlSecondsOverride', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vor-ref-ttl-override-'));
    try {
      const cache = new DiskReferenceCache(dir);
      const key = 'url:https://example.com/std.md';
      const fetchedMs = Date.parse('2026-01-01T00:00:00Z');
      cache.set(
        key,
        makeMeta(
          { fetched_at: new Date(fetchedMs).toISOString(), ttl_seconds: 86_400 },
          'cached text',
        ),
        'cached text',
      );

      expect(cache.get(key, fetchedMs + 10_000).status).toBe('hit');
      expect(cache.get(key, fetchedMs + 10_000, 5).status).toBe('stale');
      expect(cache.get(key, fetchedMs, 0).status).toBe('stale');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confines absolute configured cache dirs to safe workspace, temp, or VOR roots', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-ref-abs-ws-'));
    const tempCache = join(tmpdir(), 'vor-ref-abs-sub');
    const wsCache = join(ws, '.vor-custom-cache');
    try {
      expect(resolveReferenceCacheDir(wsCache, ws)).toContain('.vor-custom-cache');
      expect(resolveReferenceCacheDir(tempCache, ws)).toContain('vor-ref-abs-sub');

      const rejected = resolveReferenceCacheDir('/etc/vor-cache-test', ws);
      expect(rejected).not.toContain('vor-cache-test');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects relative cache dirs that escape workspace via symlink or dangling symlink', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-ref-rel-sym-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'vor-ref-rel-sym-out-'));
    try {
      mkdirSync(join(ws, '.vor'), { recursive: true });
      symlinkSync(outside, join(ws, '.vor/escaped-cache'));
      symlinkSync(join(outside, 'missing-target'), join(ws, '.vor/dangling-cache'));
      symlinkSync(ws, join(ws, '.vor/inside-link'));

      const escapedResolved = resolveReferenceCacheDir('.vor/escaped-cache', ws);
      expect(escapedResolved).not.toBe(realpathSync(outside));
      expect(escapedResolved).not.toContain('escaped-cache');

      const danglingResolved = resolveReferenceCacheDir('.vor/dangling-cache', ws);
      expect(danglingResolved).not.toContain('dangling-cache');

      const insideResolved = resolveReferenceCacheDir('.vor/inside-link/cache', ws);
      expect(insideResolved).toBe(join(realpathSync(ws), 'cache'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects symlinked cache dirs and symlinked entry files on write, read, and touch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vor-ref-entry-sym-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'vor-ref-outside-'));
    try {
      const sentinelContent = join(outsideDir, 'sentinel-content.txt');
      const sentinelMeta = join(outsideDir, 'sentinel-meta.json');
      writeFileSync(sentinelContent, 'ORIGINAL-SENTINEL', 'utf-8');
      writeFileSync(sentinelMeta, 'ORIGINAL-META-SENTINEL', 'utf-8');

      // 1. Direct symlinked cacheDir
      const symlinkCacheDir = join(outsideDir, 'linked-cache-dir');
      symlinkSync(dir, symlinkCacheDir);
      const linkedCache = new DiskReferenceCache(symlinkCacheDir);
      expect(linkedCache.set('url:https://example.com/a.md', makeMeta(), 'hello')).toBe(false);

      // 2. Symlinked .content and .meta.json entry destinations
      const cache = new DiskReferenceCache(dir);
      const key = 'url:https://example.com/std.md';
      const hash = sha256Hex(key);
      symlinkSync(sentinelContent, join(dir, `${hash}.content`));

      expect(cache.set(key, makeMeta({}, 'OVERWRITE'), 'OVERWRITE')).toBe(false);
      expect(readFileSync(sentinelContent, 'utf-8')).toBe('ORIGINAL-SENTINEL');
      expect(cache.get(key).status).toBe('miss');

      // Also guard .meta.json symlink alone (without a .content symlink) on set() and touch()
      const key2 = 'url:https://example.com/meta-only.md';
      const hash2 = sha256Hex(key2);
      symlinkSync(sentinelMeta, join(dir, `${hash2}.meta.json`));
      expect(cache.set(key2, makeMeta({ key: key2 }, 'payload'), 'payload')).toBe(false);
      expect(readFileSync(sentinelMeta, 'utf-8')).toBe('ORIGINAL-META-SENTINEL');
      expect(cache.touch(key2, { etag: '"x"' })).toBeNull();
      expect(readFileSync(sentinelMeta, 'utf-8')).toBe('ORIGINAL-META-SENTINEL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
