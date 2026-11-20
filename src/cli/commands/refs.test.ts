import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../references/cache.js';
import type { LoadedReferenceCorpus } from '../../references/loader.js';
import { renderRefsStatus, renderRefsSync } from './refs.js';

describe('vor refs renderers', () => {
  it('renders sync and cache status output cleanly without emoji', () => {
    const content = '# Standards\nUse domain events.';
    const sha = sha256Hex(content);
    const corpus: LoadedReferenceCorpus = {
      docs: [
        {
          id: 'docs/std.md',
          title: 'Standards',
          source: 'docs/std.md',
          kind: 'repo',
          placement: 'inline',
          content,
          byte_length: Buffer.byteLength(content),
          content_sha256: sha,
          headings: ['Standards'],
          truncated: false,
          cache_status: 'hit',
        },
      ],
      inline_docs: [
        {
          id: 'docs/std.md',
          title: 'Standards',
          source: 'docs/std.md',
          kind: 'repo',
          placement: 'inline',
          content,
          byte_length: Buffer.byteLength(content),
          content_sha256: sha,
          headings: ['Standards'],
          truncated: false,
          cache_status: 'hit',
        },
      ],
      on_demand_docs: [],
      total_inline_bytes: Buffer.byteLength(content),
      total_bytes: Buffer.byteLength(content),
      corpus_digest: 'abcdef1234567890',
      cache_dir: '/tmp/vor-refs-cache',
      cache_stats: { hits: 1, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
      warnings: [],
    };

    const syncOut = renderRefsSync(corpus);
    expect(syncOut).toContain('VOR reference documentation sync');
    expect(syncOut).toContain('docs/std.md');
    expect(syncOut).toContain('1 hit');

    const nowMs = Date.parse('2026-11-20T12:10:00.000Z');
    const statusOut = renderRefsStatus({
      enabled: true,
      configured_sources: 1,
      cache_dir: '/tmp/vor-refs-cache',
      nowMs,
      entries: [
        {
          version: 1,
          key: 'url:https://example.com/std.md',
          source_id: 'docs/std.md',
          title: 'Standards',
          kind: 'url',
          content_sha256: sha,
          etag: '"v1"',
          fetched_at: '2026-11-20T12:00:00.000Z',
          ttl_seconds: 3600,
          byte_length: 30,
          headings: ['Standards'],
        },
      ],
    });
    expect(statusOut).toContain('fresh');
    expect(statusOut).toContain('etag');
  });
});
