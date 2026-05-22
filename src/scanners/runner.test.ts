/**
 * Tests for the parallel scanner runner.
 *
 * The runner's contract: never throw, never let one scanner break another,
 * apply a per-scanner timeout, and cross-scanner-dedup the aggregated
 * findings before returning.
 *
 * The tests below use vi.fn() mocks for Scanner shapes so we can drive
 * applies(), throws, timeouts, and overlapping fingerprints without standing
 * up real OSV/secrets scanners.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { FileReader } from '../github/file-reader.js';
import type { SecurityConfig } from '../config/types.js';
import { InMemoryScanCache } from './cache.js';
import { runScanners, type Logger } from './runner.js';
import { emptyResult } from './types.js';
import type {
  IgnoreList,
  ScanFinding,
  ScanResult,
  Scanner,
  ScannerDeps,
} from './types.js';
import type { ScannerId } from '../types.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  const defaultReader: FileReader = {
    read: vi.fn().mockResolvedValue(null),
  } as unknown as FileReader;
  const ignoreList: IgnoreList = { matches: vi.fn().mockReturnValue({ ignored: false }) };
  return {
    octokit: {} as Octokit,
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: [],
    contextFiles: [],
    diff: '',
    workspaceDir: '/tmp',
    cache: new InMemoryScanCache(),
    ignoreList,
    fileReader: defaultReader,
    config: {} as SecurityConfig,
    ...over,
  };
}

function makeFinding(over: Partial<ScanFinding> = {}): ScanFinding {
  const scanner: ScannerId = over.scanner ?? 'secrets';
  return {
    scanner,
    rule_id: 'rule-x',
    file_path: 'src/a.ts',
    line: 1,
    severity: 'minor',
    category: 'vulnerability',
    title: 't',
    description: 'd',
    confidence: 'medium',
    evidence: { kind: 'secret', masked_match: '****', pattern_id: 'x' },
    fingerprint: 'fp-default',
    ...over,
  };
}

/**
 * Build a fake Scanner with the given id and behavior. `scanResult` may be
 * a ScanResult, a Promise, or a function returning either; the test can
 * also supply a `scan` that throws or never resolves.
 */
function makeScanner(args: {
  id: ScannerId;
  applies?: boolean | (() => boolean);
  scan?: () => Promise<ScanResult>;
}): Scanner {
  const appliesArg = args.applies ?? true;
  return {
    id: args.id,
    applies: typeof appliesArg === 'function' ? appliesArg : () => appliesArg,
    scan: args.scan ?? (async () => emptyResult(args.id)),
  };
}

function makeLogger(): Logger & {
  debug: ReturnType<typeof vi.fn>;
  notice: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    notice: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  };
}

// -----------------------------------------------------------------
// Happy path: three scanners run in parallel
// -----------------------------------------------------------------

describe('runScanners — parallel happy path', () => {
  it('runs every scanner that applies and aggregates their findings', async () => {
    // Distinct (rule_id, file_path, line, fingerprint) tuples so cross-scanner
    // dedup doesn't collapse them. The dedup logic is exercised in its own
    // test below.
    const a = makeScanner({
      id: 'dependency-cve',
      scan: async () => ({
        ...emptyResult('dependency-cve'),
        findings: [
          makeFinding({
            scanner: 'dependency-cve',
            fingerprint: 'fp-a',
            file_path: 'src/a.ts',
            line: 1,
            rule_id: 'osv:CVE-2021-A',
          }),
        ],
      }),
    });
    const b = makeScanner({
      id: 'secrets',
      scan: async () => ({
        ...emptyResult('secrets'),
        findings: [
          makeFinding({
            scanner: 'secrets',
            fingerprint: 'fp-b',
            file_path: 'src/b.ts',
            line: 2,
            rule_id: 'secret:foo',
          }),
        ],
      }),
    });
    const c = makeScanner({
      id: 'sast',
      scan: async () => ({
        ...emptyResult('sast'),
        findings: [
          makeFinding({
            scanner: 'sast',
            fingerprint: 'fp-c',
            file_path: 'src/c.ts',
            line: 3,
            rule_id: 'sast:bar',
          }),
        ],
      }),
    });

    const deps = makeScannerDeps();
    const { findings, perScanner } = await runScanners([a, b, c], deps);

    expect(findings).toHaveLength(3);
    expect(perScanner.map((r) => r.scanner)).toEqual(['dependency-cve', 'secrets', 'sast']);
    expect(perScanner.every((r) => r.errors.length === 0)).toBe(true);
  });
});

// -----------------------------------------------------------------
// Isolation: one scanner throws; others still run
// -----------------------------------------------------------------

describe('runScanners — error isolation', () => {
  it('isolates a throwing scanner; others still complete', async () => {
    const ok = makeScanner({
      id: 'secrets',
      scan: async () => ({
        ...emptyResult('secrets'),
        findings: [makeFinding({ scanner: 'secrets', fingerprint: 'fp-ok' })],
      }),
    });
    const boom = makeScanner({
      id: 'dependency-cve',
      scan: async () => {
        throw new Error('synthetic boom');
      },
    });
    const logger = makeLogger();

    const deps = makeScannerDeps();
    const { findings, perScanner } = await runScanners([boom, ok], deps, { logger });

    // Aggregated findings only contain the successful scanner's output.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.scanner).toBe('secrets');

    const boomResult = perScanner.find((r) => r.scanner === 'dependency-cve');
    expect(boomResult).toBeDefined();
    expect(boomResult!.findings).toEqual([]);
    expect(boomResult!.errors).toHaveLength(1);
    expect(boomResult!.errors[0]!.fatal).toBe(false);
    expect(boomResult!.errors[0]!.message).toContain('synthetic boom');

    const okResult = perScanner.find((r) => r.scanner === 'secrets')!;
    expect(okResult.findings).toHaveLength(1);
    expect(okResult.errors).toEqual([]);

    expect(logger.warn).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Timeout: a hung scanner doesn't block the others
// -----------------------------------------------------------------

describe('runScanners — timeout', () => {
  it('times out a hung scanner after perScannerTimeoutMs and continues', async () => {
    // The hung scanner returns a Promise that never resolves. The runner
    // races it against a tiny timeout (50ms) and converts the rejection
    // into a recovery result. We pair it with a fast scanner so we can
    // confirm parallelism is preserved.
    const hung = makeScanner({
      id: 'dependency-cve',
      scan: () => new Promise<ScanResult>(() => {}),
    });
    const fast = makeScanner({
      id: 'secrets',
      scan: async () => ({
        ...emptyResult('secrets'),
        findings: [makeFinding({ scanner: 'secrets', fingerprint: 'fp-fast' })],
      }),
    });
    const logger = makeLogger();
    const deps = makeScannerDeps();

    const start = Date.now();
    const { findings, perScanner } = await runScanners([hung, fast], deps, {
      perScannerTimeoutMs: 50,
      logger,
    });
    const elapsed = Date.now() - start;

    // 1s ceiling proves we didn't wait on the never-resolving promise.
    expect(elapsed).toBeLessThan(1000);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.scanner).toBe('secrets');

    const hungResult = perScanner.find((r) => r.scanner === 'dependency-cve')!;
    expect(hungResult.errors).toHaveLength(1);
    expect(hungResult.errors[0]!.message).toMatch(/timed out/i);
    expect(hungResult.findings).toEqual([]);

    expect(logger.warn).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// applies() === false → scan() not called
// -----------------------------------------------------------------

describe('runScanners — applies gate', () => {
  it('skips scan() entirely when applies() returns false', async () => {
    const scanSpy = vi.fn().mockResolvedValue(emptyResult('secrets'));
    const skipped = makeScanner({
      id: 'secrets',
      applies: false,
      scan: scanSpy,
    });

    const deps = makeScannerDeps();
    const { findings, perScanner } = await runScanners([skipped], deps);

    expect(scanSpy).not.toHaveBeenCalled();
    expect(findings).toEqual([]);
    expect(perScanner).toHaveLength(1);
    expect(perScanner[0]!.scanner).toBe('secrets');
    expect(perScanner[0]!.findings).toEqual([]);
    expect(perScanner[0]!.errors).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Cross-scanner dedup happens within runScanners
// -----------------------------------------------------------------

describe('runScanners — cross-scanner dedup', () => {
  it('deduplicates findings that share a fingerprint across two scanners', async () => {
    const a = makeScanner({
      id: 'dependency-cve',
      scan: async () => ({
        ...emptyResult('dependency-cve'),
        findings: [
          makeFinding({ scanner: 'dependency-cve', fingerprint: 'dup', confidence: 'low' }),
        ],
      }),
    });
    const b = makeScanner({
      id: 'secrets',
      scan: async () => ({
        ...emptyResult('secrets'),
        findings: [
          makeFinding({ scanner: 'secrets', fingerprint: 'dup', confidence: 'high' }),
        ],
      }),
    });

    const deps = makeScannerDeps();
    const { findings, perScanner } = await runScanners([a, b], deps);

    // Cross-scanner dedup keeps the higher-confidence variant.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('high');
    expect(findings[0]!.scanner).toBe('secrets');

    // Raw perScanner output is NOT deduped — both scanners reported.
    expect(perScanner[0]!.findings).toHaveLength(1);
    expect(perScanner[1]!.findings).toHaveLength(1);
  });
});
