/**
 * Tests for the two-pass scanner-finding dedup utilities.
 *
 * Pass 1 (cross-scanner): collapses duplicate findings produced by multiple
 * scanners in the same run. The higher-confidence one wins; ties break to
 * the earlier-listed scanner so the runner's perScanner-order metric stays
 * deterministic.
 *
 * Pass 2 (cross-AI): drops scanner findings overlapping a security-adjacent
 * AI comment within 3 lines, EXCEPT for dependency-cve findings which carry
 * hard CVE evidence and should never be silently suppressed.
 */
import { describe, expect, it } from 'vitest';
import type { Category, Confidence, PostedComment, ScannerId } from '../types.js';
import { dedupAcrossScanners, dedupScannerFindings } from './dedup.js';
import type { ScanFinding } from './types.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function makeFinding(over: Partial<ScanFinding> = {}): ScanFinding {
  const scanner: ScannerId = over.scanner ?? 'secrets';
  return {
    scanner,
    rule_id: 'secret:aws-access-key-id',
    file_path: 'src/foo.ts',
    line: 10,
    severity: 'critical',
    category: 'vulnerability',
    title: 'Possible AWS access key id',
    description: 'desc',
    confidence: 'high',
    evidence: { kind: 'secret', masked_match: 'AKIA...CDEF', pattern_id: 'aws-access-key-id' },
    fingerprint: 'fp-1',
    ...over,
  };
}

function makeAiComment(over: Partial<PostedComment> = {}): PostedComment {
  return {
    severity: 'important',
    file_path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    category: 'security' as Category,
    title: 'Hardcoded credential',
    why_it_matters: 'Anyone with read access to this repo can exfiltrate it.',
    confidence: 'high' as Confidence,
    ...over,
  };
}

// -----------------------------------------------------------------
// dedupAcrossScanners
// -----------------------------------------------------------------

describe('dedupAcrossScanners', () => {
  it('collapses two findings with identical fingerprint, keeping the higher-confidence one', () => {
    const lowConf = makeFinding({ scanner: 'secrets', confidence: 'low', fingerprint: 'fp-shared' });
    const highConf = makeFinding({
      scanner: 'dependency-cve',
      confidence: 'high',
      fingerprint: 'fp-shared',
    });
    const out = dedupAcrossScanners([lowConf, highConf]);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('high');
    expect(out[0]!.scanner).toBe('dependency-cve');
  });

  it('keeps both findings when fingerprints and (file,line,rule_id) triples differ', () => {
    const a = makeFinding({ fingerprint: 'fp-a', line: 10, rule_id: 'rule-a' });
    const b = makeFinding({ fingerprint: 'fp-b', line: 20, rule_id: 'rule-b' });
    const out = dedupAcrossScanners([a, b]);
    expect(out).toHaveLength(2);
  });

  it('collapses on identical (file_path, line, rule_id) even when fingerprints differ', () => {
    const a = makeFinding({ fingerprint: 'fp-a', confidence: 'low' });
    const b = makeFinding({ fingerprint: 'fp-b', confidence: 'high' });
    // Same file_path, line, rule_id but different fingerprints — should
    // still collapse to one finding (the high-confidence one).
    const out = dedupAcrossScanners([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('high');
  });

  it('on equal confidence, ties break to the earlier-listed scanner (input order)', () => {
    const first = makeFinding({
      scanner: 'secrets',
      fingerprint: 'fp-shared',
      title: 'first',
    });
    const second = makeFinding({
      scanner: 'dependency-cve',
      fingerprint: 'fp-shared',
      title: 'second',
    });
    const out = dedupAcrossScanners([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('first');
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupAcrossScanners([])).toEqual([]);
  });
});

// -----------------------------------------------------------------
// dedupScannerFindings (Pass 2)
// -----------------------------------------------------------------

describe('dedupScannerFindings', () => {
  it('drops a scanner finding that overlaps an AI security comment within 3 lines', () => {
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 12 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([]);
  });

  it('keeps a scanner finding when the line distance exceeds 3', () => {
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 15 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([finding]);
  });

  it('protects dependency-cve findings even when an AI comment overlaps closely', () => {
    const cve = makeFinding({
      scanner: 'dependency-cve',
      line: 10,
      rule_id: 'osv:CVE-2021-1234',
      fingerprint: 'cve-fp',
      evidence: {
        kind: 'cve',
        osv_id: 'CVE-2021-1234',
        ecosystem: 'npm',
        package: 'left-pad',
        affected_version: '1.2.0',
      },
    });
    const ai = makeAiComment({ category: 'vulnerability', line: 10 });
    const out = dedupScannerFindings({ scanFindings: [cve], aiComments: [ai] });
    expect(out).toEqual([cve]);
  });

  it('keeps a scanner finding when the overlapping AI comment is non-security-adjacent', () => {
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'readability', line: 10 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([finding]);
  });

  it('keeps the scanner finding when the overlapping AI comment is category=bug', () => {
    // Rationale (Codex P2): `bug` is too broad to count as security-adjacent.
    // A nearby unrelated bug note (e.g. null deref) must NOT suppress a real
    // scanner secret/SAST finding by line proximity alone.
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'bug', line: 7 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([finding]);
  });

  it('drops the scanner finding for category=data-loss at distance 3 (boundary)', () => {
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'data-loss', line: 7 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([]);
  });

  it('keeps the scanner finding when the AI comment is on a different file', () => {
    const finding = makeFinding({ scanner: 'secrets', file_path: 'src/foo.ts', line: 10 });
    const ai = makeAiComment({ category: 'security', file_path: 'src/bar.ts', line: 10 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [ai] });
    expect(out).toEqual([finding]);
  });

  it('passes scanner findings through unchanged when there are no AI comments', () => {
    const finding = makeFinding({ scanner: 'secrets', line: 10 });
    const out = dedupScannerFindings({ scanFindings: [finding], aiComments: [] });
    expect(out).toEqual([finding]);
  });

  it('returns an empty array when scanFindings is empty', () => {
    const ai = makeAiComment({ category: 'security', line: 10 });
    const out = dedupScannerFindings({ scanFindings: [], aiComments: [ai] });
    expect(out).toEqual([]);
  });
});
