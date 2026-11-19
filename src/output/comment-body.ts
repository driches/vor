import type { PostedComment } from '../types.js';

export function renderCommentBody(c: PostedComment): string {
  const severityTag = c.severity.toUpperCase();
  // Tag both `low` and `medium`; `high` stays silent (it's the agent default
  // and would clutter every finding). Tagging medium makes the heading
  // self-describing for human reviewers (so they know not to assume hard
  // evidence) and lets the eval-harness adapter round-trip the original
  // confidence without silently rounding medium up to high.
  // See PR #10 comment 3295156534.
  const confTag =
    c.confidence === 'low'
      ? ' · low confidence'
      : c.confidence === 'medium'
        ? ' · medium confidence'
        : '';
  const heading = `**[${severityTag} · ${c.category}${confTag}]** ${c.title}`;
  const why = c.why_it_matters;
  const suggestion = c.suggestion
    ? `\n\n\`\`\`suggestion\n${c.suggestion.replace(/\n$/, '')}\n\`\`\``
    : '';
  const provenance = renderProvenanceTag(c);
  return `${heading}\n\n${why}${suggestion}${provenance}`;
}

/**
 * Renders a small inline tag identifying the scanner that produced a finding.
 * AI-originated comments (no `source` field, or `source.kind === 'agent'`)
 * produce no tag so their rendered body is unchanged.
 */
function renderProvenanceTag(c: PostedComment): string {
  if (!c.source || c.source.kind !== 'scanner') return '';
  switch (c.source.scanner) {
    case 'dependency-cve': {
      // Prefer the explicit CVE/GHSA alias when OSV provided one. Fall back
      // to the rule_id with the `osv:` prefix stripped (RUSTSEC, PYSEC,
      // etc. don't have CVE/GHSA aliases but we don't want to render
      // `_via OSV · osv:PYSEC-…_` with the redundant prefix).
      const id =
        c.source.cve_id ?? c.source.ghsa_id ?? c.source.rule_id?.replace(/^osv:/, '') ?? '';
      return `\n\n_via OSV · ${id}_`;
    }
    case 'secrets':
      return '\n\n_via secrets scan_';
    case 'sast':
      return '\n\n_via SAST_';
    case 'container-cve':
      return '\n\n_via container scan_';
    case 'coverage-delta':
      return '\n\n_via coverage scan_';
    case 'debris':
      return '\n\n_via debris scan_';
    case 'migration-safety':
      return '\n\n_via migration safety scan_';
    case 'dependency-hygiene':
      return '\n\n_via dependency hygiene scan_';
    case 'image-ocr':
      return '\n\n_via image OCR scan_';
    default: {
      const _exhaustive: never = c.source.scanner;
      void _exhaustive;
      return '';
    }
  }
}
