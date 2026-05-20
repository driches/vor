import { describe, expect, it } from 'vitest';
import { scanFindingToPostedComment } from './adapter.js';
import type { ScanFinding } from './types.js';

function makeFinding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    scanner: 'dependency-cve',
    rule_id: 'osv:GHSA-xxxx-yyyy-zzzz',
    file_path: 'package-lock.json',
    line: 42,
    severity: 'critical',
    category: 'vulnerability',
    title: 'foo@1.2.3 has CVE-2024-0001',
    description: 'Upgrade to 1.2.4 or later. CVSS 9.1.',
    confidence: 'high',
    evidence: {
      kind: 'cve',
      cve_id: 'CVE-2024-0001',
      ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
      osv_id: 'GHSA-xxxx-yyyy-zzzz',
      ecosystem: 'npm',
      package: 'foo',
      affected_version: '1.2.3',
      fixed_version: '1.2.4',
      cvss: 9.1,
    },
    fingerprint: 'dep-cve:GHSA-xxxx-yyyy-zzzz:foo:package-lock.json',
    ...over,
  };
}

describe('scanFindingToPostedComment', () => {
  it('converts a CVE finding with full source attribution', () => {
    const c = scanFindingToPostedComment(makeFinding());
    expect(c).toEqual({
      severity: 'critical',
      file_path: 'package-lock.json',
      line: 42,
      side: 'RIGHT',
      category: 'vulnerability',
      title: 'foo@1.2.3 has CVE-2024-0001',
      why_it_matters: 'Upgrade to 1.2.4 or later. CVSS 9.1.',
      confidence: 'high',
      source: {
        kind: 'scanner',
        scanner: 'dependency-cve',
        rule_id: 'osv:GHSA-xxxx-yyyy-zzzz',
        cve_id: 'CVE-2024-0001',
        ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
      },
    });
  });

  it('omits start_line when not present (not set to undefined)', () => {
    const c = scanFindingToPostedComment(makeFinding());
    expect('start_line' in c).toBe(false);
  });

  it('includes start_line when present', () => {
    const c = scanFindingToPostedComment(makeFinding({ start_line: 38 }));
    expect(c.start_line).toBe(38);
  });

  it('omits suggestion when not present (not set to undefined)', () => {
    const c = scanFindingToPostedComment(makeFinding());
    expect('suggestion' in c).toBe(false);
  });

  it('includes suggestion when present', () => {
    const c = scanFindingToPostedComment(makeFinding({ suggestion: '"foo": "^1.2.4"' }));
    expect(c.suggestion).toBe('"foo": "^1.2.4"');
  });

  it('omits cve_id / ghsa_id when the CVE evidence lacks them', () => {
    const c = scanFindingToPostedComment(
      makeFinding({
        evidence: {
          kind: 'cve',
          osv_id: 'OSV-2024-0001',
          ecosystem: 'PyPI',
          package: 'bar',
          affected_version: '0.1.0',
        },
      }),
    );
    expect(c.source).toEqual({
      kind: 'scanner',
      scanner: 'dependency-cve',
      rule_id: 'osv:GHSA-xxxx-yyyy-zzzz',
    });
    expect('cve_id' in (c.source ?? {})).toBe(false);
    expect('ghsa_id' in (c.source ?? {})).toBe(false);
  });

  it('converts a secrets finding without CVE/GHSA on source', () => {
    const c = scanFindingToPostedComment(
      makeFinding({
        scanner: 'secrets',
        rule_id: 'aws-access-key-id',
        category: 'security',
        severity: 'critical',
        title: 'AWS access key id in source',
        evidence: {
          kind: 'secret',
          masked_match: 'AKIA****************',
          pattern_id: 'aws-access-key-id',
        },
      }),
    );
    expect(c.category).toBe('security');
    expect(c.source).toEqual({
      kind: 'scanner',
      scanner: 'secrets',
      rule_id: 'aws-access-key-id',
    });
  });

  it('converts a SAST finding without CVE/GHSA on source', () => {
    const c = scanFindingToPostedComment(
      makeFinding({
        scanner: 'sast',
        rule_id: 'js/sql-injection',
        evidence: {
          kind: 'sast',
          rule_id: 'js/sql-injection',
          cwe: ['CWE-89'],
        },
      }),
    );
    expect(c.source).toEqual({
      kind: 'scanner',
      scanner: 'sast',
      rule_id: 'js/sql-injection',
    });
  });

  it('attributes the first CVE for a container finding', () => {
    const c = scanFindingToPostedComment(
      makeFinding({
        scanner: 'container-cve',
        rule_id: 'container:node:20-alpine',
        evidence: {
          kind: 'container',
          base_image: 'node',
          tag: '20-alpine',
          cve_ids: ['CVE-2024-1111', 'CVE-2024-2222'],
        },
      }),
    );
    expect(c.source).toEqual({
      kind: 'scanner',
      scanner: 'container-cve',
      rule_id: 'container:node:20-alpine',
      cve_id: 'CVE-2024-1111',
    });
  });

  it('omits cve_id when a container finding has an empty cve_ids list', () => {
    const c = scanFindingToPostedComment(
      makeFinding({
        scanner: 'container-cve',
        rule_id: 'container:node:20-alpine',
        evidence: {
          kind: 'container',
          base_image: 'node',
          tag: '20-alpine',
          cve_ids: [],
        },
      }),
    );
    expect(c.source).toEqual({
      kind: 'scanner',
      scanner: 'container-cve',
      rule_id: 'container:node:20-alpine',
    });
    expect('cve_id' in (c.source ?? {})).toBe(false);
  });

  it('maps description → why_it_matters', () => {
    const c = scanFindingToPostedComment(makeFinding({ description: 'Replace because reasons.' }));
    expect(c.why_it_matters).toBe('Replace because reasons.');
  });

  it('always sets side to RIGHT', () => {
    const c = scanFindingToPostedComment(makeFinding());
    expect(c.side).toBe('RIGHT');
  });
});
