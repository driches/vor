import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../types.js';
import type { ScanFinding } from './types.js';
import { validateScanFinding, type ScannerValidationContext } from './validate.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 10,
    deletions: 2,
    reviewable_lines: [
      [10, 15],
      [25, 30],
    ],
    added_lines: new Set([10, 11, 12, 13, 14, 15, 25, 26, 27, 28, 29, 30]),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 100,
    head_line_text: new Map([[10, 'const x = 1;']]),
    ...over,
  };
}

function makeCtx(over: Partial<ScannerValidationContext> = {}): ScannerValidationContext {
  const file = over.changedFiles?.get('src/foo.ts') ?? makeFile();
  return {
    changedFiles: new Map([[file.path, file]]),
    ...over,
  };
}

function makeFinding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    scanner: 'dependency-cve',
    rule_id: 'osv:test',
    file_path: 'src/foo.ts',
    line: 12,
    severity: 'critical',
    category: 'vulnerability',
    title: 'test finding',
    description: 'because',
    confidence: 'high',
    evidence: {
      kind: 'cve',
      osv_id: 'OSV-0',
      ecosystem: 'npm',
      package: 'p',
      affected_version: '1',
    },
    fingerprint: 'fp',
    ...over,
  };
}

describe('validateScanFinding', () => {
  it('accepts a valid finding', () => {
    const r = validateScanFinding(makeFinding(), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('rejects when file_path is not in the PR', () => {
    const r = validateScanFinding(makeFinding({ file_path: 'src/missing.ts' }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('not in this PR');
  });

  it('rejects when file is binary', () => {
    const ctx = makeCtx({
      changedFiles: new Map([['src/foo.ts', makeFile({ is_binary: true })]]),
    });
    const r = validateScanFinding(makeFinding(), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('binary');
  });

  it('accepts findings on generated files (scanner findings carry evidence)', () => {
    const ctx = makeCtx({
      changedFiles: new Map([['src/foo.ts', makeFile({ is_generated: true })]]),
    });
    const r = validateScanFinding(makeFinding(), ctx);
    expect(r.ok).toBe(true);
  });

  it('accepts a dependency-cve finding on a lockfile (canonical CVE anchor)', () => {
    const lockfile = makeFile({
      path: 'package-lock.json',
      language: 'json',
      is_generated: true,
      reviewable_lines: [[5, 20]],
      head_line_text: new Map([[10, '      "version": "4.17.20",']]),
    });
    const ctx: ScannerValidationContext = {
      changedFiles: new Map([[lockfile.path, lockfile]]),
    };
    const finding = makeFinding({
      file_path: 'package-lock.json',
      line: 10,
      evidence: {
        kind: 'cve',
        osv_id: 'GHSA-jf85-cpcp-j695',
        ecosystem: 'npm',
        package: 'lodash',
        affected_version: '4.17.20',
      },
    });
    const r = validateScanFinding(finding, ctx);
    expect(r.ok).toBe(true);
  });

  it('rejects when line is outside reviewable ranges', () => {
    const r = validateScanFinding(makeFinding({ line: 50 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('line 50');
  });

  it('accepts a valid multi-line finding', () => {
    const r = validateScanFinding(makeFinding({ line: 14, start_line: 11 }), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('rejects when start_line >= line', () => {
    const r = validateScanFinding(makeFinding({ line: 12, start_line: 12 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('start_line');
  });

  it('rejects when start_line > line', () => {
    const r = validateScanFinding(makeFinding({ line: 12, start_line: 14 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('start_line');
  });

  it('rejects when start_line is outside reviewable ranges', () => {
    const r = validateScanFinding(makeFinding({ line: 14, start_line: 5 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('start_line 5');
  });

  it('accepts the boundary line of a reviewable range', () => {
    const r = validateScanFinding(makeFinding({ line: 10 }), makeCtx());
    expect(r.ok).toBe(true);
  });
});
