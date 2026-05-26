/**
 * Convert a scanner's {@link ScanFinding} into the {@link PostedComment}
 * shape used by the GitHub review poster. This is the only place that
 * marshals scanner-flavored fields (CVE id, secret pattern, etc.) into the
 * `FindingSource` provenance attached to each posted comment.
 */
import type { FindingSource, PostedComment } from '../types.js';
import type { ScanFinding } from './types.js';

export function scanFindingToPostedComment(f: ScanFinding): PostedComment {
  // Omit optional fields rather than setting them to undefined — keeps the
  // posted JSON tidy and avoids surprising consumers that distinguish
  // `key: undefined` from `key absent`.
  return {
    severity: f.severity,
    file_path: f.file_path,
    line: f.line,
    ...(f.start_line !== undefined ? { start_line: f.start_line } : {}),
    side: 'RIGHT',
    category: f.category,
    title: f.title,
    why_it_matters: f.description,
    ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    confidence: f.confidence,
    source: buildSource(f),
  };
}

function buildSource(f: ScanFinding): FindingSource {
  // Build the final object once. Omit optional fields when absent so the
  // posted JSON doesn't carry undefined values.
  switch (f.evidence.kind) {
    case 'cve':
      return {
        kind: 'scanner',
        scanner: f.scanner,
        rule_id: f.rule_id,
        ...(f.evidence.cve_id !== undefined ? { cve_id: f.evidence.cve_id } : {}),
        ...(f.evidence.ghsa_id !== undefined ? { ghsa_id: f.evidence.ghsa_id } : {}),
      };
    case 'secret':
      // No CVE/GHSA — `rule_id` carries the pattern attribution.
      return { kind: 'scanner', scanner: f.scanner, rule_id: f.rule_id };
    case 'sast':
      // No CVE/GHSA — `rule_id` carries the SAST rule id; CWE lives in the
      // finding's evidence and can be surfaced by the formatter.
      return { kind: 'scanner', scanner: f.scanner, rule_id: f.rule_id };
    case 'container': {
      // Container findings can list multiple CVEs against one base image;
      // attribute the first to the comment's source so a single GHSA link is
      // available. The full list remains in the finding's evidence.
      const first = f.evidence.cve_ids[0];
      return {
        kind: 'scanner',
        scanner: f.scanner,
        rule_id: f.rule_id,
        ...(first !== undefined ? { cve_id: first } : {}),
      };
    }
    case 'coverage':
      // No CVE/GHSA — `rule_id` carries the scanner attribution; the
      // specific tool that produced the coverage data lives in evidence.
      return { kind: 'scanner', scanner: f.scanner, rule_id: f.rule_id };
  }
}
