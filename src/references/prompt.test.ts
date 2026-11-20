import { describe, expect, it } from 'vitest';
import { sha256Hex } from './cache.js';
import type { LoadedReferenceCorpus } from './loader.js';
import { renderReferencesPrompt } from './prompt.js';

function makeCorpus(over: Partial<LoadedReferenceCorpus> = {}): LoadedReferenceCorpus {
  return {
    docs: [],
    inline_docs: [],
    on_demand_docs: [],
    total_inline_bytes: 0,
    total_bytes: 0,
    corpus_digest: 'abc',
    cache_dir: '/tmp/cache',
    cache_stats: { hits: 0, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
    warnings: [],
    ...over,
  };
}

describe('renderReferencesPrompt', () => {
  it('returns null when corpus has no documents', () => {
    expect(renderReferencesPrompt(makeCorpus())).toBeNull();
  });

  it('renders inline docs and on-demand catalog deterministically without volatile metadata', () => {
    const inlineDoc = {
      id: 'docs/std.md',
      title: 'Coding Standards',
      source: 'docs/std.md',
      kind: 'repo' as const,
      placement: 'inline' as const,
      content: '# Coding Standards\nUse strict types.',
      byte_length: 35,
      content_sha256: sha256Hex('# Coding Standards\nUse strict types.'),
      headings: ['Coding Standards'],
      truncated: false,
      cache_status: 'hit' as const,
    };
    const onDemandDoc = {
      id: 'docs/big-adr.md',
      title: 'Big ADR',
      source: 'docs/big-adr.md',
      kind: 'repo' as const,
      placement: 'on_demand' as const,
      content: '# Big ADR\n## Context\n...',
      byte_length: 4096,
      content_sha256: sha256Hex('# Big ADR\n## Context\n...'),
      headings: ['Big ADR', 'Context'],
      truncated: false,
      cache_status: 'miss' as const,
    };

    const a = renderReferencesPrompt(
      makeCorpus({
        docs: [inlineDoc, onDemandDoc],
        inline_docs: [inlineDoc],
        on_demand_docs: [onDemandDoc],
        cache_stats: { hits: 1, revalidated: 0, misses: 1, stale_fallbacks: 0, uncached: 0 },
      }),
    );
    // Different cache_stats must produce byte-identical prompt output
    const b = renderReferencesPrompt(
      makeCorpus({
        docs: [inlineDoc, onDemandDoc],
        inline_docs: [inlineDoc],
        on_demand_docs: [onDemandDoc],
        cache_stats: { hits: 2, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
      }),
    );

    expect(a).toBe(b);
    expect(a).toContain('#### Coding Standards (`docs/std.md`)');
    expect(a).toContain('Use strict types.');
    expect(a).toContain('Additional reference docs (on-demand via `read_reference_doc`)');
    expect(a).toContain('| `docs/big-adr.md` | Big ADR | 4 KB | Big ADR, Context |');
  });
});
