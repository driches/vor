import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
