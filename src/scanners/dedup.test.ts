/**
 * Tests for the two-pass scanner-finding dedup utilities.
 *
 * Pass 1 (cross-scanner): collapses duplicate findings produced by multiple
 * scanners in the same run. The higher-confidence one wins; ties break to
 * the earlier-listed scanner so the runner's perScanner-order metric stays
 * deterministic.
 *
 * Pass 2 (scanner precedence): removes AI comments that overlap a validated
 * scanner finding. Security-adjacent findings may overlap within 3 lines;
 * other categories must match on the exact line.
 */
import { describe, expect, it } from 'vitest';
import type { Category, Confidence, PostedComment, ScannerId, Severity } from '../types.js';
import { dedupAcrossScanners, dedupCommentsWithScannerPrecedence } from './dedup.js';
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

function makeScannerComment(
  over: Partial<PostedComment> & { scanner?: ScannerId } = {},
): PostedComment {
  const scanner = over.scanner ?? 'secrets';
  // Build base then override; explicitly forward `source` so callers can opt
  // out (e.g. by passing source: undefined for the "no source means AI" path
  // tested below).
  return {
    severity: 'critical' as Severity,
    file_path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    category: 'vulnerability' as Category,
    title: 'Possible AWS access key id',
    why_it_matters: 'desc',
    confidence: 'high' as Confidence,
    source: { kind: 'scanner', scanner, rule_id: 'secret:aws-access-key-id' },
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
    source: { kind: 'agent', model: 'claude-sonnet-4-6' },
    ...over,
  };
}

// -----------------------------------------------------------------
// dedupAcrossScanners
// -----------------------------------------------------------------

describe('dedupAcrossScanners', () => {
  it('collapses two findings with identical fingerprint, keeping the higher-confidence one', () => {
    const lowConf = makeFinding({
      scanner: 'secrets',
      confidence: 'low',
      fingerprint: 'fp-shared',
    });
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

  it('merges two previously-disjoint slots when a third finding bridges their keys', () => {
    // Regression for the divergent-fp/triple bug: scanner A reports a
    // finding with (fp=X, triple=t1), scanner B reports a finding with
    // (fp=Y, triple=t2). They land in distinct slots. Then scanner C
    // reports (fp=X, triple=t2) — which matches A by fingerprint AND B by
    // triple. Without the merge, A and B remain as separate entries in
    // the output (silent duplicate). With the merge, all three collapse
    // into one finding.
    const a = makeFinding({
      scanner: 'secrets',
      fingerprint: 'fp-X',
      file_path: 'a.ts',
      line: 1,
      rule_id: 'rule-1',
      confidence: 'low',
      title: 'A',
    });
    const b = makeFinding({
      scanner: 'secrets',
      fingerprint: 'fp-Y',
      file_path: 'a.ts',
      line: 2,
      rule_id: 'rule-2',
      confidence: 'medium',
      title: 'B',
    });
    const c = makeFinding({
      scanner: 'secrets',
      fingerprint: 'fp-X', // matches A
      file_path: 'a.ts',
      line: 2,
      rule_id: 'rule-2', // matches B's triple
      confidence: 'high',
      title: 'C',
    });
    const out = dedupAcrossScanners([a, b, c]);
    expect(out).toHaveLength(1);
    // The highest-confidence finding wins.
    expect(out[0]!.confidence).toBe('high');
    expect(out[0]!.title).toBe('C');
  });
});

// -----------------------------------------------------------------
// dedupCommentsWithScannerPrecedence
// -----------------------------------------------------------------

describe('dedupCommentsWithScannerPrecedence', () => {
  it('keeps the scanner finding when it overlaps an AI security comment', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 12 });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner]);
  });

  it('keeps scanner precedence regardless of input order', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 12 });
    expect(dedupCommentsWithScannerPrecedence([ai, scanner])).toEqual([scanner]);
  });

  it('keeps both comments when categories do not describe the same issue family', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'readability', line: 10 });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner, ai]);
  });

  it('applies scanner precedence at the security overlap boundary', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'data-loss', line: 7 });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner]);
  });

  it('keeps both security comments when the line distance exceeds 3', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 15 });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner, ai]);
  });

  it('keeps only dependency-cve evidence when the agent reports the same vulnerability', () => {
    const cve = makeScannerComment({
      scanner: 'dependency-cve',
      line: 10,
      source: {
        kind: 'scanner',
        scanner: 'dependency-cve',
        rule_id: 'osv:CVE-2021-1234',
        cve_id: 'CVE-2021-1234',
      },
    });
    const ai = makeAiComment({ category: 'vulnerability', line: 10 });
    expect(dedupCommentsWithScannerPrecedence([cve, ai])).toEqual([cve]);
  });

  it('uses exact-line category matching for non-security scanner findings', () => {
    const scanner = makeScannerComment({
      scanner: 'debris',
      category: 'bug',
      line: 10,
    });
    const sameLineAi = makeAiComment({ category: 'bug', line: 10 });
    const nearbyAi = makeAiComment({ category: 'bug', line: 11, title: 'Different nearby bug' });

    expect(dedupCommentsWithScannerPrecedence([scanner, sameLineAi, nearbyAi])).toEqual([
      scanner,
      nearbyAi,
    ]);
  });

  it('keeps both comments when they refer to different files', () => {
    const scanner = makeScannerComment({ file_path: 'src/foo.ts', line: 10 });
    const ai = makeAiComment({ file_path: 'src/bar.ts', line: 10 });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner, ai]);
  });

  it('passes scanner-only and empty inputs through', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    expect(dedupCommentsWithScannerPrecedence([scanner])).toEqual([scanner]);
    expect(dedupCommentsWithScannerPrecedence([])).toEqual([]);
  });

  it('keeps both comments when they anchor to different diff sides', () => {
    const scanner = makeScannerComment({ line: 10, side: 'RIGHT' });
    const ai = makeAiComment({ line: 10, side: 'LEFT' });
    expect(dedupCommentsWithScannerPrecedence([scanner, ai])).toEqual([scanner, ai]);
  });

  it('treats a sourceless comment as AI and gives the scanner precedence', () => {
    const ai: PostedComment = {
      severity: 'critical',
      file_path: 'examples/smoke-test-bad-code.ts',
      line: 11,
      side: 'RIGHT',
      category: 'security',
      title: 'Hardcoded AWS access key ID',
      why_it_matters: 'Committing a key in source exposes the credential.',
      confidence: 'high',
    };
    const scanner = makeScannerComment({
      scanner: 'secrets',
      file_path: 'examples/smoke-test-bad-code.ts',
      line: 11,
      category: 'vulnerability',
      title: 'Possible AWS access key id in smoke-test-bad-code.ts',
    });

    expect(dedupCommentsWithScannerPrecedence([ai, scanner])).toEqual([scanner]);
  });
});
