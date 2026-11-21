import { describe, expect, it } from 'vitest';
import { sha256Hex } from './cache.js';
import type { LoadedReferenceCorpus } from './loader.js';
import { readReferenceSlice } from './search.js';

function makeSingleDocCorpus(content: string): LoadedReferenceCorpus {
  return {
    docs: [
      {
        id: 'oversized',
        title: 'Oversized Doc',
        source: 'docs/oversized.txt',
        kind: 'repo',
        placement: 'on_demand',
        content,
        byte_length: Buffer.byteLength(content, 'utf-8'),
        content_sha256: sha256Hex(content),
        headings: [],
        truncated: false,
        cache_status: 'miss',
      },
    ],
    inline_docs: [],
    on_demand_docs: [],
    total_inline_bytes: 0,
    total_bytes: Buffer.byteLength(content, 'utf-8'),
    corpus_digest: 'digest-oversized',
    cache_dir: '/tmp/cache',
    cache_stats: { hits: 0, revalidated: 0, misses: 1, stale_fallbacks: 0, uncached: 0 },
    warnings: [],
  };
}

describe('readReferenceSlice', () => {
  it('caps an oversized first line within MAX_SLICE_BYTES on a UTF-8 boundary', () => {
    const longFirstLine = 'a'.repeat(30_000);
    const corpus = makeSingleDocCorpus(`${longFirstLine}\nsecond line`);

    const res = readReferenceSlice(corpus, { id: 'oversized', start_line: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(24_000);
    expect(res.content).toContain('(truncated at 24000 bytes)');
    expect(res.returned_range).toEqual([1, 1]);
  });

  it('stops before adding subsequent lines that would exceed MAX_SLICE_BYTES', () => {
    const line = 'b'.repeat(10_000);
    const corpus = makeSingleDocCorpus(`${line}\n${line}\n${line}`);

    const res = readReferenceSlice(corpus, { id: 'oversized', start_line: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.truncated).toBe(true);
    expect(res.returned_range).toEqual([1, 2]);
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(24_000);
  });

  it('sets truncated to false when an explicit end_line completes and true when default slicing stops early', () => {
    const lines = Array.from({ length: 450 }, (_, idx) => `line ${idx + 1}`).join('\n');
    const corpus = makeSingleDocCorpus(lines);

    const explicit = readReferenceSlice(corpus, { id: 'oversized', start_line: 1, end_line: 2 });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.truncated).toBe(false);
    expect(explicit.returned_range).toEqual([1, 2]);

    const defaulted = readReferenceSlice(corpus, { id: 'oversized', start_line: 1 });
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.truncated).toBe(true);
    expect(defaulted.returned_range).toEqual([1, 400]);

    const largeLine = 'c'.repeat(10_000);
    const byteCapped = readReferenceSlice(
      makeSingleDocCorpus(`${largeLine}\n${largeLine}\n${largeLine}`),
      { id: 'oversized', start_line: 1, end_line: 3 },
    );
    expect(byteCapped.ok).toBe(true);
    if (!byteCapped.ok) return;
    expect(byteCapped.truncated).toBe(true);
    expect(byteCapped.returned_range).toEqual([1, 2]);

    const pastEof = readReferenceSlice(makeSingleDocCorpus('line 1\nline 2\nline 3'), {
      id: 'oversized',
      start_line: 1,
      end_line: 100,
    });
    expect(pastEof.ok).toBe(true);
    if (!pastEof.ok) return;
    expect(pastEof.truncated).toBe(false);
    expect(pastEof.returned_range).toEqual([1, 3]);
    expect(pastEof.total_lines).toBe(3);
  });
});
