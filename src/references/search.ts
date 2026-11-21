/**
 * Pure catalog, line-sliced reading, and keyword search over a pre-loaded
 * {@link LoadedReferenceCorpus}. Shared between the agent's `read_reference_doc`
 * tool and the MCP server's `read_reference` tool with zero disk/network I/O.
 */

import type { LoadedReferenceCorpus } from './loader.js';
import { truncateUtf8Bytes } from './text.js';

const DEFAULT_SLICE_LINES = 400;
const MAX_SLICE_BYTES = 24_000;

export interface ReferenceCatalogItem {
  id: string;
  title: string;
  kind: 'repo' | 'url' | 'github';
  placement: 'inline' | 'on_demand';
  byte_length: number;
  headings: string[];
}

export type ReadReferenceSliceResult =
  | {
      ok: true;
      id: string;
      title: string;
      source: string;
      kind: 'repo' | 'url' | 'github';
      total_lines: number;
      returned_range: [number, number];
      truncated: boolean;
      content: string;
    }
  | {
      ok: false;
      error: string;
      available_ids: string[];
    };

export interface ReferenceSearchHit {
  id: string;
  title: string;
  line: number;
  excerpt: string;
}

export function listReferenceCatalog(corpus: LoadedReferenceCorpus): ReferenceCatalogItem[] {
  return corpus.docs.map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    placement: d.placement,
    byte_length: d.byte_length,
    headings: d.headings,
  }));
}

export function readReferenceSlice(
  corpus: LoadedReferenceCorpus,
  opts: { id: string; start_line?: number; end_line?: number },
): ReadReferenceSliceResult {
  const doc = corpus.docs.find((d) => d.id === opts.id);
  if (!doc) {
    return {
      ok: false,
      error: `Reference document '${opts.id}' was not found.`,
      available_ids: corpus.docs.map((d) => d.id),
    };
  }

  const lines = doc.content.split('\n');
  const totalLines = lines.length;
  const start = Math.max(1, opts.start_line ?? 1);
  if (start > totalLines) {
    return {
      ok: true,
      id: doc.id,
      title: doc.title,
      source: doc.source,
      kind: doc.kind,
      total_lines: totalLines,
      returned_range: [totalLines, totalLines],
      truncated: false,
      content: '',
    };
  }

  const requestedEnd = opts.end_line ?? start + DEFAULT_SLICE_LINES - 1;
  const hardEnd = Math.min(totalLines, Math.max(start, requestedEnd));

  const kept: string[] = [];
  let byteCount = 0;
  let actualEnd = start - 1;
  // Explicit end_line ranges start un-truncated and flip true only if MAX_SLICE_BYTES cuts them short.
  let truncated = opts.end_line === undefined && hardEnd < totalLines;

  for (let ln = start; ln <= hardEnd; ln++) {
    const lineText = lines[ln - 1] ?? '';
    const lineBytes = Buffer.byteLength(lineText, 'utf-8') + (kept.length > 0 ? 1 : 0);
    if (byteCount + lineBytes > MAX_SLICE_BYTES) {
      if (kept.length === 0) {
        kept.push(truncateUtf8Bytes(lineText, MAX_SLICE_BYTES).content);
        actualEnd = ln;
      }
      truncated = true;
      break;
    }
    kept.push(lineText);
    byteCount += lineBytes;
    actualEnd = ln;
  }

  return {
    ok: true,
    id: doc.id,
    title: doc.title,
    source: doc.source,
    kind: doc.kind,
    total_lines: totalLines,
    returned_range: [start, Math.max(start, actualEnd)],
    truncated,
    content: kept.join('\n'),
  };
}

export function searchReferenceCorpus(
  corpus: LoadedReferenceCorpus,
  query: string,
  maxMatches = 15,
): ReferenceSearchHit[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const hits: ReferenceSearchHit[] = [];

  for (const doc of corpus.docs) {
    const lines = doc.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lower = line.toLowerCase();
      const matched =
        lower.includes(trimmed) || (tokens.length > 1 && tokens.every((t) => lower.includes(t)));
      if (!matched) continue;
      const clean = line.trim();
      hits.push({
        id: doc.id,
        title: doc.title,
        line: i + 1,
        excerpt: clean.length <= 200 ? clean : `${clean.slice(0, 197)}...`,
      });
      if (hits.length >= maxMatches) return hits;
    }
  }

  return hits;
}
