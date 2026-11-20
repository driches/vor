/**
 * Byte-deterministic prompt rendering for reference documentation & standards.
 *
 * IMPORTANT for LLM prompt caching (Anthropic `cache_control` + OpenAI prefix
 * caching): NEVER embed timestamps, fetch durations, or cache hit/miss counts
 * inside this output — the rendered section must stay byte-identical across
 * turns and runs whenever the reference corpus hasn't changed.
 */

import type { LoadedReferenceCorpus } from './loader.js';

export function renderReferencesPrompt(corpus: LoadedReferenceCorpus): string | null {
  if (corpus.docs.length === 0) return null;

  const lines: string[] = [
    '### Reference documentation & standards',
    '',
    'Follow these authoritative team/organization standards when reviewing changes. Cite the relevant standard by title or document ID when flagging a violation.',
  ];

  for (const doc of corpus.inline_docs) {
    lines.push('', `#### ${doc.title} (\`${doc.id}\`)`, '', doc.content);
  }

  if (corpus.on_demand_docs.length > 0) {
    lines.push(
      '',
      '#### Additional reference docs (on-demand via `read_reference_doc`)',
      '',
      'These documents exceeded the inline prompt budget or are marked on-demand. Whenever a change touches their domain, call `read_reference_doc({ id })` or `read_reference_doc({ query })` to verify compliance:',
      '',
      '| ID | Title | Size | Key sections |',
      '|---|---|---|---|',
    );
    for (const doc of corpus.on_demand_docs) {
      const sizeKb = `${Math.max(1, Math.round(doc.byte_length / 1024))} KB`;
      const sections = doc.headings.length > 0 ? doc.headings.slice(0, 4).join(', ') : '—';
      lines.push(`| \`${doc.id}\` | ${doc.title} | ${sizeKb} | ${sections} |`);
    }
  }

  return lines.join('\n');
}
