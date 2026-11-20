import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../references/cache.js';
import type { LoadedReferenceCorpus } from '../references/loader.js';
import { makeReadReferenceDocTool } from './read-reference-doc.js';
import { buildFakeDeps, callTool, getResultJson, getResultText } from './test-helpers.js';

function makeCorpus(): LoadedReferenceCorpus {
  const c1 = '# API Standards\nUse versioned routes.\nReturn RFC 7807 errors.';
  const c2 = '# DDD Rules\nProtect aggregate invariants.\nUse value objects for money.';
  return {
    docs: [
      {
        id: 'api',
        title: 'API Standards',
        source: 'docs/api.md',
        kind: 'repo',
        placement: 'inline',
        content: c1,
        byte_length: Buffer.byteLength(c1),
        content_sha256: sha256Hex(c1),
        headings: ['API Standards'],
        truncated: false,
        cache_status: 'hit',
      },
      {
        id: 'ddd',
        title: 'DDD Rules',
        source: 'docs/ddd.md',
        kind: 'repo',
        placement: 'on_demand',
        content: c2,
        byte_length: Buffer.byteLength(c2),
        content_sha256: sha256Hex(c2),
        headings: ['DDD Rules'],
        truncated: false,
        cache_status: 'hit',
      },
    ],
    inline_docs: [],
    on_demand_docs: [],
    total_inline_bytes: 0,
    total_bytes: Buffer.byteLength(c1) + Buffer.byteLength(c2),
    corpus_digest: 'digest123',
    cache_dir: '/tmp/cache',
    cache_stats: { hits: 2, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
    warnings: [],
  };
}

describe('read_reference_doc tool', () => {
  it('lists catalog when called with empty args, reads slice by id, and searches by query', async () => {
    const tool = makeReadReferenceDocTool({
      ...buildFakeDeps(),
      references: makeCorpus(),
    });

    const listRes = getResultJson(await callTool(tool, {})) as {
      total_docs: number;
      docs: Array<{ id: string }>;
    };
    expect(listRes.total_docs).toBe(2);
    expect(listRes.docs.map((d) => d.id)).toEqual(['api', 'ddd']);

    const sliceRes = getResultJson(
      await callTool(tool, { id: 'ddd', start_line: 2, end_line: 2 }),
    ) as { content: string; returned_range: [number, number] };
    expect(sliceRes.content).toBe('Protect aggregate invariants.');
    expect(sliceRes.returned_range).toEqual([2, 2]);

    const queryRes = getResultJson(await callTool(tool, { query: 'RFC 7807' })) as {
      match_count: number;
      matches: Array<{ id: string; line: number }>;
    };
    expect(queryRes.match_count).toBe(1);
    expect(queryRes.matches[0]).toMatchObject({ id: 'api', line: 3 });

    const missing = await callTool(tool, { id: 'nope' });
    expect(getResultText(missing)).toContain('Available IDs: api, ddd');
  });
});
