/**
 * Tests for the two-pass scanner-finding dedup utilities.
 *
 * Pass 1 (cross-scanner): collapses duplicate findings produced by multiple
 * scanners in the same run. The higher-confidence one wins; ties break to
 * the earlier-listed scanner so the runner's perScanner-order metric stays
 * deterministic.
 *
 * Pass 2 (post-filter cross-AI): drops scanner-sourced comments that overlap
 * a surviving AI comment in a security-adjacent category within 3 lines,
 * EXCEPT for dependency-cve findings which carry hard CVE evidence and
 * should never be silently suppressed. Runs over the post-filter kept list
 * so scanner findings only lose to AI comments that actually post.
 */
import { describe, expect, it } from 'vitest';
import type {
  Category,
  Confidence,
  PostedComment,
  ScannerId,
  Severity,
} from '../types.js';
import { dedupAcrossScanners, dedupKeptScannerComments } from './dedup.js';
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
// dedupKeptScannerComments (Pass 2 — post-filter)
// -----------------------------------------------------------------

describe('dedupKeptScannerComments', () => {
  it('drops a scanner comment that overlaps an AI security comment within 3 lines', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 12 });
    const out = dedupKeptScannerComments([scanner, ai]);
    // Only the AI comment survives.
    expect(out).toEqual([ai]);
  });

  it('keeps a scanner comment at boundary distance=3 only if the category misses', () => {
    // distance=3 is INSIDE the window. Pair with a non-adjacent category to
    // verify the category check is what saves it.
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'readability', line: 7 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([scanner, ai]);
  });

  it('drops the scanner comment at boundary distance=3 with a security-adjacent AI category', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'data-loss', line: 7 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([ai]);
  });

  it('keeps a scanner comment when the line distance exceeds 3', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'security', line: 15 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([scanner, ai]);
  });

  it('protects dependency-cve scanner comments even when an AI comment overlaps closely', () => {
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
    const out = dedupKeptScannerComments([cve, ai]);
    expect(out).toEqual([cve, ai]);
  });

  it('keeps a scanner comment when the overlapping AI comment is non-security-adjacent', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'readability', line: 10 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([scanner, ai]);
  });

  it('keeps the scanner comment when the overlapping AI comment is category=bug', () => {
    // Rationale (Codex P2 on the prior fix): `bug` is too broad to count as
    // security-adjacent. A nearby unrelated bug note (e.g. null deref) must
    // NOT suppress a real scanner secret/SAST finding by line proximity alone.
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai = makeAiComment({ category: 'bug', line: 7 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([scanner, ai]);
  });

  it('keeps the scanner comment when the AI comment is on a different file', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', file_path: 'src/foo.ts', line: 10 });
    const ai = makeAiComment({ category: 'security', file_path: 'src/bar.ts', line: 10 });
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([scanner, ai]);
  });

  it('passes scanner comments through unchanged when there are no AI comments in the kept list', () => {
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const out = dedupKeptScannerComments([scanner]);
    expect(out).toEqual([scanner]);
  });

  it('returns an empty array for an empty kept list', () => {
    expect(dedupKeptScannerComments([])).toEqual([]);
  });

  it('treats a comment with no `source` as AI (backward compat) and dedups against it', () => {
    // `source` is optional on PostedComment; absence is treated as AI per the
    // type comment. A scanner finding overlapping a sourceless security
    // comment should still be suppressed.
    const scanner = makeScannerComment({ scanner: 'secrets', line: 10 });
    const ai: PostedComment = {
      severity: 'important',
      file_path: 'src/foo.ts',
      line: 12,
      side: 'RIGHT',
      category: 'security',
      title: 'Sourceless AI comment',
      why_it_matters: 'AI-originated; source field omitted for backward compat.',
      confidence: 'high',
    };
    const out = dedupKeptScannerComments([scanner, ai]);
    expect(out).toEqual([ai]);
  });
});
