/**
 * Tests for the dependency-cve scanner.
 *
 * Covers the public `createDependencyCveScanner({ osvClient, parsers, logger })`
 * factory: applies/scan contract, OSV happy path, cache dedup across two
 * lockfiles, network-failure degradation, ignore-list integration (including
 * the expired-suppression notice), upgrade-hint mapping in the description,
 * parser no-match, and severity-bucket mapping from CVSS (numeric + vector).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createDependencyCveScanner, type Logger } from './dependency-cve.js';
import {
  OsvClientError,
  type OsvClient,
  type OsvBatchResponse,
  type OsvVuln,
} from './osv-client.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  // Permissive default for `added_lines` (1..1000) so the test lockfile
  // fixtures — all <30 lines — "look added" by default. Tests targeting
  // the added-lines filter override this explicitly (e.g. with `new Set()`
  // to assert that non-added deps are skipped).
  const defaultAdded = new Set<number>();
  for (let i = 1; i <= 1000; i += 1) defaultAdded.add(i);
  return {
    path: 'package-lock.json',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: defaultAdded,
    language: 'json',
    is_generated: true,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

/** Minimal package-lock.json for a single dep — JSON layout chosen so the line
 *  anchor for lodash is deterministic for assertions below. */
const LODASH_PACKAGE_LOCK = [
  '{',
  '  "name": "test",',
  '  "version": "1.0.0",',
  '  "lockfileVersion": 3,',
  '  "packages": {',
  '    "": { "name": "test", "version": "1.0.0" },',
  '    "node_modules/lodash": {',
  '      "version": "4.17.20"',
  '    }',
  '  }',
  '}',
].join('\n');

const LODASH_YARN_LOCK = [
  'lodash@^4.17.0:',
  '  version "4.17.20"',
  '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz"',
].join('\n');

const LODASH_VULN: OsvVuln = {
  id: 'GHSA-jf85-cpcp-j695',
  aliases: ['CVE-2019-10744'],
  summary: 'Prototype Pollution in lodash',
  severity: [{ type: 'CVSS_V3', score: '9.1' }],
  affected: [
    {
      package: { name: 'lodash', ecosystem: 'npm' },
      ranges: [
        {
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '4.17.12' }],
        },
      ],
    },
  ],
};

const LODASH_BATCH_RESPONSE: OsvBatchResponse = {
  results: [{ vulns: [{ id: 'GHSA-jf85-cpcp-j695', modified: '2024-01-01T00:00:00Z' }] }],
};

function makeOsvClient(over: Partial<OsvClient> = {}): OsvClient {
  return {
    queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
    getVuln: vi.fn().mockResolvedValue(LODASH_VULN),
    ...over,
  };
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
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

/**
 * Default ScannerDeps for happy-path scenarios. Tests override the
 * `changedFiles` and `fileReader` to feed specific lockfiles in.
 */
function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  const defaultReader: FileReader = {
    read: vi.fn().mockResolvedValue(null),
  } as unknown as FileReader;
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
    ignoreList: makeIgnoreList(),
    fileReader: defaultReader,
    config: {} as SecurityConfig,
    signal: new AbortController().signal,
    ...over,
  };
}

// -----------------------------------------------------------------
// applies()
// -----------------------------------------------------------------

describe('createDependencyCveScanner — applies()', () => {
  it('returns true when at least one changed file matches a lockfile parser', () => {
    const scanner = createDependencyCveScanner();
    expect(scanner.applies([makeChangedFile({ path: 'package-lock.json' })])).toBe(true);
  });

  it('returns false when no changed file matches any parser', () => {
    const scanner = createDependencyCveScanner();
    expect(
      scanner.applies([
        makeChangedFile({ path: 'src/foo.ts', is_generated: false, language: 'ts' }),
      ]),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------
// scan() — happy path
// -----------------------------------------------------------------

describe('createDependencyCveScanner — yarn header-only addition (regression)', () => {
  it('scans a yarn dep when only the header line is added (body version is context)', async () => {
    // Regression for Codex P2: yarn parser anchors `line` to the body's
    // `version "..."` line. If the PR only adds a new selector to an
    // existing header (header_line added but version line stays as
    // context), the dep would previously be dropped because
    // `added_lines.has(d.line)` was false. Now we also check
    // `added_lines.has(d.header_line)` so header-only additions still
    // trigger OSV scanning.
    const yarnLock = [
      '"lodash@^4.17.0":', // line 1 — header (we'll mark this as added)
      '  version "4.17.20"', // line 2 — version body (we'll mark as context, NOT added)
      '  resolved "https://example.com/lodash"', // line 3
      '',
    ].join('\n');
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(yarnLock),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    // Only line 1 (the header) is added; line 2 (version body) is context.
    const file = makeChangedFile({
      path: 'yarn.lock',
      added_lines: new Set([1]),
    });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [file], fileReader: reader }),
    );

    expect(result.findings).toHaveLength(1);
    expect(osvClient.queryBatch).toHaveBeenCalled();
    // The finding still anchors on the version body line (line 2) so the
    // comment lands on the user's mental "this is the line that says
    // 4.17.20" — even though that line was context, not added.
    expect(result.findings[0]!.line).toBe(2);
  });
});

describe('createDependencyCveScanner — added-lines filter', () => {
  it('skips deps whose line is NOT in file.added_lines (avoids OSV budget exhaustion on large lockfiles)', async () => {
    // Regression for Codex P1: previously every parsed dep was queried,
    // even ones the PR didn't touch. The orchestrator dropped non-reviewable
    // findings later — but the OSV calls still happened, exhausting the
    // 60s scanner budget. Now the scanner filters to file.added_lines first.
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    // lodash version sits at line 8 in the fixture. Use added_lines that
    // explicitly EXCLUDES line 8 (and the ±5-line lookahead window the parser
    // uses).
    const onlyOtherLines = new Set([1, 2, 3, 20, 21]);
    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [
          makeChangedFile({ path: 'package-lock.json', added_lines: onlyOtherLines }),
        ],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(0);
    expect(osvClient.queryBatch).not.toHaveBeenCalled();
    expect(osvClient.getVuln).not.toHaveBeenCalled();
  });
});

describe('createDependencyCveScanner — scan() happy path', () => {
  it('produces a critical lodash CVE finding from a package-lock.json', async () => {
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.scanner).toBe('dependency-cve');
    expect(finding.rule_id).toBe('osv:GHSA-jf85-cpcp-j695');
    expect(finding.severity).toBe('critical');
    expect(finding.category).toBe('vulnerability');
    expect(finding.confidence).toBe('high');
    expect(finding.file_path).toBe('package-lock.json');
    // The lodash version line in the fixture sits at line 8.
    expect(finding.line).toBeGreaterThanOrEqual(7);
    expect(finding.line).toBeLessThanOrEqual(9);

    // Evidence (cve-kind) fields.
    expect(finding.evidence.kind).toBe('cve');
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    expect(finding.evidence.ghsa_id).toBe('GHSA-jf85-cpcp-j695');
    expect(finding.evidence.cve_id).toBe('CVE-2019-10744');
    expect(finding.evidence.cvss).toBe(9.1);
    expect(finding.evidence.fixed_version).toBe('4.17.12');
    expect(finding.evidence.osv_id).toBe('GHSA-jf85-cpcp-j695');
    expect(finding.evidence.ecosystem).toBe('npm');
    expect(finding.evidence.package).toBe('lodash');
    expect(finding.evidence.affected_version).toBe('4.17.20');

    // Upgrade hint lives in the description (NOT the suggestion field — see
    // dependency-cve.ts buildDescription for why). No suggestion is set.
    expect(finding.description).toContain('>=4.17.12');
    expect('suggestion' in finding).toBe(false);

    // Deterministic 12-char hex fingerprint.
    expect(finding.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // No errors.
    expect(result.errors).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Cache dedup across two lockfiles
// -----------------------------------------------------------------

describe('createDependencyCveScanner — cache dedup', () => {
  it('queries OSV exactly once even when the same dep appears in two lockfiles', async () => {
    const osvClient = makeOsvClient();
    // Different content per path; both resolve to lodash@4.17.20.
    const reader: FileReader = {
      read: vi.fn().mockImplementation(async (ref: { path: string }) => {
        if (ref.path === 'package-lock.json') return LODASH_PACKAGE_LOCK;
        if (ref.path === 'yarn.lock') return LODASH_YARN_LOCK;
        return null;
      }),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [
          makeChangedFile({ path: 'package-lock.json' }),
          makeChangedFile({ path: 'yarn.lock', language: 'lockfile' }),
        ],
        fileReader: reader,
      }),
    );

    expect(osvClient.queryBatch).toHaveBeenCalledTimes(1);
    // Both lockfiles produce a finding — one per file.
    expect(result.findings).toHaveLength(2);
    const paths = result.findings.map((f) => f.file_path).sort();
    expect(paths).toEqual(['package-lock.json', 'yarn.lock']);
  });
});

// -----------------------------------------------------------------
// OSV queryBatch failure
// -----------------------------------------------------------------

describe('createDependencyCveScanner — OSV queryBatch failure', () => {
  it('returns empty findings + error when OSV rejects, and does not throw', async () => {
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockRejectedValue(new OsvClientError('boom', 503)),
      getVuln: vi.fn(),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toEqual([]);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => /osv/i.test(e.message))).toBe(true);
    expect(osvClient.getVuln).not.toHaveBeenCalled();
  });

  it('still surfaces cache-hit findings when the uncached-deps batch fails', async () => {
    // Regression: previously the catch block returned an empty findings
    // array immediately, discarding any cache-hit vuln_ids already on
    // resolvedDeps. Now we record the error and fall through to Step 4
    // so cache-hit findings still get rendered.
    //
    // Setup: prime the cache with a known OsvBatchHit for lodash@4.17.20
    // (no uncached deps would normally be issued, but we add a second
    // lockfile entry with a DIFFERENT version to force a batch round-trip
    // that fails). The scanner should still emit a finding for the cached
    // lodash, with the failure recorded in errors[].
    const cache = new InMemoryScanCache();
    cache.set('osv-batch:npm:lodash:4.17.20', {
      vulns: [{ id: 'GHSA-jf85-cpcp-j695', modified: '2024-01-01T00:00:00Z' }],
    });

    // Two-package lockfile: lodash@4.17.20 (cached) + uncached@1.0.0
    // (forces a batch query, which we'll fail).
    const TWO_PKG_LOCK = [
      '{',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "app", "version": "1.0.0" },',
      '    "node_modules/lodash": { "version": "4.17.20" },',
      '    "node_modules/uncached-pkg": { "version": "1.0.0" }',
      '  }',
      '}',
    ].join('\n');

    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockRejectedValue(new OsvClientError('OSV down', 503)),
      // getVuln is allowed to be called for the cache-hit lodash CVE.
      getVuln: vi.fn().mockResolvedValue(LODASH_VULN),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(TWO_PKG_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
        cache,
      }),
    );

    // Cache-hit lodash finding survives; uncached-pkg silently has no
    // finding (we don't know if it's vulnerable).
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence.kind).toBe('cve');
    if (result.findings[0]!.evidence.kind === 'cve') {
      expect(result.findings[0]!.evidence.package).toBe('lodash');
    }
    // The batch failure is recorded as a non-fatal error.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]!.message).toMatch(/OSV batch query failed/);
    // getVuln was still called for the cache-hit vuln.
    expect(osvClient.getVuln).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Ignore-list — straight match
// -----------------------------------------------------------------

describe('createDependencyCveScanner — ignored finding', () => {
  it('drops findings that match an ignore entry', async () => {
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const ignoreList = makeIgnoreList({ ignored: true, reason: 'test-suppress' });
    const logger = makeLogger();
    const scanner = createDependencyCveScanner({ osvClient, logger });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
        ignoreList,
      }),
    );

    expect(result.findings).toEqual([]);
    expect(ignoreList.matches).toHaveBeenCalled();
    // Non-expired ignore should NOT trigger the expired-notice path.
    expect(logger.notice).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Ignore-list — expired entry
// -----------------------------------------------------------------

describe('createDependencyCveScanner — expired ignore entry', () => {
  it('drops the finding AND emits a logger.notice mentioning the rule_id', async () => {
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const ignoreList = makeIgnoreList({
      ignored: true,
      expired: true,
      reason: 'old-suppress',
    });
    const logger = makeLogger();
    const scanner = createDependencyCveScanner({ osvClient, logger });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
        ignoreList,
      }),
    );

    expect(result.findings).toEqual([]);
    expect(logger.notice).toHaveBeenCalledTimes(1);
    const noticeMsg = logger.notice.mock.calls[0]![0] as string;
    expect(noticeMsg).toMatch(/expired/i);
    expect(noticeMsg).toContain('osv:GHSA-jf85-cpcp-j695');
  });
});

// -----------------------------------------------------------------
// Fixed-version mapping
// -----------------------------------------------------------------

describe('createDependencyCveScanner — fixed-version upgrade hint in description', () => {
  it("appends 'Upgrade <pkg> to >=<fixed>' to the description, and sets no suggestion field", async () => {
    const osvClient = makeOsvClient();
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    // Suggestion field is reserved for code replacements GitHub will apply
    // literally to the target line — unsafe for lockfile lines. The upgrade
    // hint goes in the description instead.
    expect('suggestion' in finding).toBe(false);
    expect(finding.description).toContain('Upgrade lodash to >=4.17.12');
    if (finding.evidence.kind !== 'cve') {
      throw new Error('expected cve evidence');
    }
    expect(finding.evidence.fixed_version).toBe('4.17.12');
  });
});

// -----------------------------------------------------------------
// Empty parsed deps
// -----------------------------------------------------------------

describe('createDependencyCveScanner — empty deps after parsing', () => {
  it('produces no findings and makes no OSV calls when the lockfile parses to []', async () => {
    const osvClient = makeOsvClient();
    // Empty packages object — parser returns [] (no entries, none with versions).
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue('{ "packages": {} }'),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toEqual([]);
    expect(osvClient.queryBatch).not.toHaveBeenCalled();
    expect(osvClient.getVuln).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Severity mapping from CVSS (numeric scores)
// -----------------------------------------------------------------

describe('createDependencyCveScanner — severity mapping from CVSS', () => {
  const cases: Array<{ cvss: string; expected: 'critical' | 'important' | 'minor' | 'nit' }> = [
    { cvss: '9.5', expected: 'critical' },
    { cvss: '8.0', expected: 'important' },
    { cvss: '5.0', expected: 'minor' },
    { cvss: '2.0', expected: 'nit' },
  ];

  for (const { cvss, expected } of cases) {
    it(`maps CVSS ${cvss} → ${expected}`, async () => {
      const vuln: OsvVuln = {
        ...LODASH_VULN,
        severity: [{ type: 'CVSS_V3', score: cvss }],
      };
      const osvClient: OsvClient = {
        queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
        getVuln: vi.fn().mockResolvedValue(vuln),
      };
      const reader: FileReader = {
        read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
      } as unknown as FileReader;
      const scanner = createDependencyCveScanner({ osvClient });

      const result = await scanner.scan(
        makeScannerDeps({
          changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
          fileReader: reader,
        }),
      );

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.severity).toBe(expected);
      if (result.findings[0]!.evidence.kind !== 'cve') {
        throw new Error('expected cve evidence');
      }
      expect(result.findings[0]!.evidence.cvss).toBeCloseTo(Number(cvss), 5);
    });
  }
});

// -----------------------------------------------------------------
// CVSS vector parsing (the common OSV form)
// -----------------------------------------------------------------

/**
 * End-to-end coverage for the inline CVSS v3.0/v3.1 base-score parser.
 *
 * We drive the scanner with a synthetic OSV vuln whose `severity[0].score` is
 * a vector string and assert the parsed numeric CVSS shows up on
 * `evidence.cvss`. This exercises `parseCvssScore` → `highestCvssScore` →
 * `deriveSeverity` → finding shape end-to-end, without exporting an internal.
 *
 * Vector expected values were derived from the official CVSS v3.1 formula
 * (https://www.first.org/cvss/v3.1/specification-document §7) and
 * cross-checked against the NIST CVSS calculator.
 */
describe('createDependencyCveScanner — CVSS vector parsing', () => {
  const vectorCases: Array<{
    name: string;
    score: string;
    expectedCvss: number | undefined;
    expectedSeverity: 'critical' | 'important' | 'minor' | 'nit';
  }> = [
    {
      // Canonical CVSS v3.1 worst-case vector — every metric at its highest
      // attacker-favourable value. NIST's own example for "9.8 critical".
      name: 'v3.1 critical (canonical 9.8)',
      score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      expectedCvss: 9.8,
      expectedSeverity: 'critical',
    },
    {
      // Medium vector exercising PR:N + UI:R + partial impact. Computes to 5.4.
      // (AV:N, AC:L, PR:N, UI:R, S:U, C:L, I:L, A:N) — confirmed against the
      // NIST calculator.
      name: 'v3.1 medium (5.4)',
      score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N',
      expectedCvss: 5.4,
      expectedSeverity: 'minor',
    },
    {
      // Same metric set as the canonical 9.8 case, but in v3.0 — the formula
      // is identical for v3.0 and v3.1, so it must also score 9.8.
      name: 'v3.0 critical (9.8 — same formula as v3.1)',
      score: 'CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      expectedCvss: 9.8,
      expectedSeverity: 'critical',
    },
    {
      // Scope:Changed vector — exercises the alternate Impact formula and
      // the 1.08 multiplier. NIST's classic "S:C" example. Computes to 10.0.
      name: 'v3.1 scope-changed (10.0)',
      score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H',
      expectedCvss: 10.0,
      expectedSeverity: 'critical',
    },
    {
      // v4.0 vectors are intentionally not supported in v1 of this scanner;
      // the formula differs materially. Expect parseCvssScore to return
      // undefined so the caller falls through to database_specific.severity.
      name: 'v4.0 vector (not supported)',
      score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
      expectedCvss: undefined,
      expectedSeverity: 'important', // deriveSeverity default when nothing parses
    },
    {
      // Garbage input — must NOT throw and must NOT spuriously parse.
      name: 'garbage string',
      score: 'not-a-cvss-anything',
      expectedCvss: undefined,
      expectedSeverity: 'important',
    },
  ];

  for (const { name, score, expectedCvss, expectedSeverity } of vectorCases) {
    it(`parses ${name}`, async () => {
      const vuln: OsvVuln = {
        ...LODASH_VULN,
        severity: [{ type: 'CVSS_V3', score }],
        // Strip any database_specific so the fallback path doesn't mask
        // the undefined-cvss cases.
        database_specific: undefined,
      };
      const osvClient: OsvClient = {
        queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
        getVuln: vi.fn().mockResolvedValue(vuln),
      };
      const reader: FileReader = {
        read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
      } as unknown as FileReader;
      const scanner = createDependencyCveScanner({ osvClient });

      const result = await scanner.scan(
        makeScannerDeps({
          changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
          fileReader: reader,
        }),
      );

      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0]!;
      if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
      if (expectedCvss === undefined) {
        expect(finding.evidence.cvss).toBeUndefined();
      } else {
        expect(finding.evidence.cvss).toBeCloseTo(expectedCvss, 5);
      }
      expect(finding.severity).toBe(expectedSeverity);
    });
  }

  it('rejects numeric strings out of [0,10] range', async () => {
    const vuln: OsvVuln = {
      ...LODASH_VULN,
      severity: [{ type: 'CVSS_V3', score: '15' }],
      database_specific: undefined,
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
      getVuln: vi.fn().mockResolvedValue(vuln),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    // Out-of-range numeric string should NOT parse — evidence.cvss must be
    // omitted and severity falls through to the deriveSeverity default.
    expect(finding.evidence.cvss).toBeUndefined();
  });

  it('falls back to CVSS_V2 when the preferred V3/V4 subset is unparseable', async () => {
    // Regression: parseCvssScore returns undefined for CVSS v4 vectors
    // (we don't implement v4's base-score formula). If an advisory has
    // ONLY a v4 entry + a v2 entry, the old logic filtered to V3/V4 (just
    // the v4 vector), couldn't parse it, and dropped to the
    // database_specific fallback — even though the v2 score WAS usable.
    // Now highestCvssScore falls through to the full severity list when
    // the preferred subset yields nothing.
    const vuln: OsvVuln = {
      ...LODASH_VULN,
      severity: [
        { type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H' },
        { type: 'CVSS_V2', score: '8.5' },
      ],
      database_specific: undefined,
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
      getVuln: vi.fn().mockResolvedValue(vuln),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    // V2 score was used after V3/V4 yielded nothing parseable.
    expect(finding.evidence.cvss).toBeCloseTo(8.5, 5);
    expect(finding.severity).toBe('important'); // 8.5 → important
  });
});

// -----------------------------------------------------------------
// Severity fallback from database_specific.severity (no CVSS)
// -----------------------------------------------------------------

describe('createDependencyCveScanner — database_specific.severity fallback', () => {
  it.each([
    { dbSpecific: 'CRITICAL', expected: 'critical' as const },
    { dbSpecific: 'HIGH', expected: 'important' as const },
    { dbSpecific: 'MODERATE', expected: 'minor' as const },
    { dbSpecific: 'LOW', expected: 'nit' as const },
  ])(
    'falls back to database_specific.severity=$dbSpecific → $expected when no CVSS',
    async ({ dbSpecific, expected }) => {
      // Vuln record with no `severity[]` array; only database_specific.severity.
      const vuln: OsvVuln = {
        ...LODASH_VULN,
        severity: undefined,
        database_specific: { severity: dbSpecific },
      };
      const osvClient: OsvClient = {
        queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
        getVuln: vi.fn().mockResolvedValue(vuln),
      };
      const reader: FileReader = {
        read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
      } as unknown as FileReader;
      const scanner = createDependencyCveScanner({ osvClient });

      const result = await scanner.scan(
        makeScannerDeps({
          changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
          fileReader: reader,
        }),
      );

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.severity).toBe(expected);
      if (result.findings[0]!.evidence.kind !== 'cve') {
        throw new Error('expected cve evidence');
      }
      // No numeric CVSS available → evidence.cvss should be undefined.
      expect(result.findings[0]!.evidence.cvss).toBeUndefined();
    },
  );
});

// -----------------------------------------------------------------
// findFixedVersion returns undefined → no suggestion / no fixed_version
// -----------------------------------------------------------------

describe('createDependencyCveScanner — no fixed version available', () => {
  it('omits suggestion and evidence.fixed_version when OSV has no fixed event', async () => {
    // Vuln record with affected ranges but no `fixed` event — e.g. an
    // outstanding advisory with no remediation yet.
    const vuln: OsvVuln = {
      ...LODASH_VULN,
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [{ introduced: '0' }],
            },
          ],
        },
      ],
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
      getVuln: vi.fn().mockResolvedValue(vuln),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect('suggestion' in finding).toBe(false);
    expect(finding.evidence).not.toHaveProperty('fixed_version');
  });
});

// -----------------------------------------------------------------
// getVuln failure for one id doesn't drop findings for the other
// -----------------------------------------------------------------

describe('createDependencyCveScanner — getVuln partial failure', () => {
  it('keeps findings for vulns whose getVuln succeeded, records an error for the failure', async () => {
    // Two deps in a single package-lock; queryBatch returns vulns for both;
    // the first getVuln rejects and the second resolves. We expect one
    // finding (the success) plus one error mentioning the failed id.
    const TWO_PKG_LOCK = [
      '{',
      '  "name": "test",',
      '  "version": "1.0.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "test", "version": "1.0.0" },',
      '    "node_modules/lodash": {',
      '      "version": "4.17.20"',
      '    },',
      '    "node_modules/minimist": {',
      '      "version": "1.2.5"',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const FAILED_ID = 'GHSA-failed-aaaa-bbbb';
    const OK_ID = 'GHSA-jf85-cpcp-j695';

    const batchResp: OsvBatchResponse = {
      results: [
        { vulns: [{ id: FAILED_ID, modified: '2024-01-01T00:00:00Z' }] },
        { vulns: [{ id: OK_ID, modified: '2024-01-01T00:00:00Z' }] },
      ],
    };

    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(batchResp),
      getVuln: vi.fn().mockImplementation(async (id: string) => {
        if (id === FAILED_ID) throw new OsvClientError('boom', 500);
        return LODASH_VULN;
      }),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(TWO_PKG_LOCK),
    } as unknown as FileReader;
    const logger = makeLogger();
    const scanner = createDependencyCveScanner({ osvClient, logger });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.message.includes(FAILED_ID))).toBe(true);
    // Scan must not throw — implicit from awaiting above without try/catch.
  });
});

// -----------------------------------------------------------------
// PyPI case-insensitive name matching for findFixedVersion
// -----------------------------------------------------------------

describe('createDependencyCveScanner — PyPI case-folding for findFixedVersion', () => {
  it('matches Flask (caps) against affected.package.name=flask (lower)', async () => {
    // requirements.txt with `Flask==2.3.2` — note the capital F.
    const REQ_TXT = ['Flask==2.3.2'].join('\n');
    // OSV publishes the affected name as lowercase `flask` (PEP 503).
    const FLASK_VULN: OsvVuln = {
      id: 'GHSA-flask-xxxx-yyyy',
      aliases: ['CVE-2023-30861'],
      summary: 'Flask cookie disclosure',
      severity: [{ type: 'CVSS_V3', score: '7.5' }],
      affected: [
        {
          package: { name: 'flask', ecosystem: 'PyPI' },
          ranges: [
            {
              type: 'ECOSYSTEM',
              events: [{ introduced: '0' }, { fixed: '2.3.3' }],
            },
          ],
        },
      ],
    };
    const batch: OsvBatchResponse = {
      results: [{ vulns: [{ id: 'GHSA-flask-xxxx-yyyy', modified: '2024-01-01T00:00:00Z' }] }],
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(batch),
      getVuln: vi.fn().mockResolvedValue(FLASK_VULN),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(REQ_TXT),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [
          makeChangedFile({
            path: 'requirements.txt',
            language: 'plain',
            is_generated: false,
          }),
        ],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    expect(finding.evidence.fixed_version).toBe('2.3.3');
    // Upgrade hint is in the description, not the suggestion field.
    expect('suggestion' in finding).toBe(false);
    expect(finding.description).toContain('>=2.3.3');
  });
});

// -----------------------------------------------------------------
// getVuln() calls run in parallel
// -----------------------------------------------------------------

/**
 * Sequential `await getVuln(id)` for each vuln id makes a lockfile with N
 * CVEs cost N * latency. The scanner runs in parallel via Promise.all so
 * total wall-clock latency stays near the slowest single fetch.
 *
 * The test plants 3 different vuln ids (one per dep) each waiting 50ms,
 * then asserts the whole scan completes in well under 3 * 50ms. The
 * threshold is generous (well above 50ms but well below 150ms) so test-
 * runner jitter on slower CI doesn't make this flaky.
 */
describe('createDependencyCveScanner — parallel getVuln', () => {
  it('fetches multiple vuln records in parallel (not serially)', async () => {
    // Three deps in one lockfile, each mapping to a distinct vuln id.
    const THREE_PKG_LOCK = [
      '{',
      '  "name": "test",',
      '  "version": "1.0.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "test", "version": "1.0.0" },',
      '    "node_modules/lodash": {',
      '      "version": "4.17.20"',
      '    },',
      '    "node_modules/minimist": {',
      '      "version": "1.2.5"',
      '    },',
      '    "node_modules/axios": {',
      '      "version": "0.21.0"',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const ID_A = 'GHSA-aaaa-aaaa-aaaa';
    const ID_B = 'GHSA-bbbb-bbbb-bbbb';
    const ID_C = 'GHSA-cccc-cccc-cccc';

    const batchResp: OsvBatchResponse = {
      results: [
        { vulns: [{ id: ID_A, modified: '2024-01-01T00:00:00Z' }] },
        { vulns: [{ id: ID_B, modified: '2024-01-01T00:00:00Z' }] },
        { vulns: [{ id: ID_C, modified: '2024-01-01T00:00:00Z' }] },
      ],
    };

    // Each getVuln sleeps 50ms before returning a shaped vuln. If the calls
    // run serially the total cost is ~150ms; in parallel it's ~50ms.
    const SLEEP_MS = 50;
    // 3 * 50ms = 150ms serial. Threshold sits ~20ms below serial so jitter
    // (GC pauses, slow CI runners) doesn't cause flakes while still being
    // unambiguously parallel (a serial run would be ≥150ms).
    const PARALLEL_THRESHOLD_MS = 145;
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(batchResp),
      getVuln: vi.fn().mockImplementation(async (id: string) => {
        await new Promise((r) => setTimeout(r, SLEEP_MS));
        return { ...LODASH_VULN, id };
      }),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(THREE_PKG_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const start = Date.now();
    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );
    const elapsed = Date.now() - start;

    expect(osvClient.getVuln).toHaveBeenCalledTimes(3);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    // Parallel: should be < ~150ms (3 * 50ms serial). Threshold is generous
    // to absorb CI jitter while still distinguishing parallel from serial.
    expect(elapsed).toBeLessThan(PARALLEL_THRESHOLD_MS);
  });
});

// -----------------------------------------------------------------
// findFixedVersion ignores GIT-type ranges
// -----------------------------------------------------------------

describe('createDependencyCveScanner — GIT range filter for findFixedVersion', () => {
  it('does NOT surface a commit SHA as the fixed_version when the only range is GIT-typed', async () => {
    // Regression: OSV ranges have three types (SEMVER, ECOSYSTEM, GIT).
    // GIT-typed ranges store commit SHAs in their `fixed` events; without
    // filtering, the scanner would render "Upgrade lodash to >=abc123..." —
    // useless advice that doesn't map to a published version.
    //
    // Vuln has ONLY a GIT range with a sha-shaped `fixed` event. Expected:
    // no fixed_version surfaced (we never pick a SHA), and the description
    // doesn't carry an upgrade hint.
    const SHA = 'abc123def4567890abc123def4567890abc12345';
    const GIT_ONLY_VULN: OsvVuln = {
      ...LODASH_VULN,
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [
            {
              type: 'GIT',
              events: [{ introduced: '0' }, { fixed: SHA }],
            },
          ],
        },
      ],
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
      getVuln: vi.fn().mockResolvedValue(GIT_ONLY_VULN),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    // The SHA must NOT leak as an upgrade target.
    expect(finding.evidence.fixed_version).toBeUndefined();
    expect(finding.description).not.toContain(SHA);
    // And the upgrade-hint sentence is absent.
    expect(finding.description).not.toContain('Upgrade');
  });

  it('prefers a non-GIT range when GIT and SEMVER ranges coexist on the same advisory', async () => {
    // Mixed advisory: a SEMVER range with a real version-string fix AND a
    // sibling GIT range with a sha. The scanner must pick the SEMVER fix
    // (the published advice) regardless of array order.
    const SHA = 'fedcba9876543210fedcba9876543210fedcba98';
    const MIXED_VULN: OsvVuln = {
      ...LODASH_VULN,
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [
            {
              type: 'GIT',
              events: [{ introduced: '0' }, { fixed: SHA }],
            },
            {
              type: 'SEMVER',
              events: [{ introduced: '0' }, { fixed: '4.17.21' }],
            },
          ],
        },
      ],
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(LODASH_BATCH_RESPONSE),
      getVuln: vi.fn().mockResolvedValue(MIXED_VULN),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(LODASH_PACKAGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    expect(finding.evidence.fixed_version).toBe('4.17.21');
    expect(finding.description).toContain('>=4.17.21');
    expect(finding.description).not.toContain(SHA);
  });
});

// -----------------------------------------------------------------
// findFixedVersion picks the range containing the affected version
// -----------------------------------------------------------------

describe('createDependencyCveScanner — version-aware range matching', () => {
  it('returns the fix from the 2.x range (not the 1.x range) when the lockfile is on 2.0.0', async () => {
    // Regression: an advisory can publish multiple SEMVER ranges in parallel
    // — e.g. one covering 1.x with `fixed: 1.8.5` and another covering 2.x
    // with `fixed: 2.3.1`. A lockfile pinned to 2.0.0 must surface `2.3.1`
    // as the upgrade target. The old code returned the FIRST `fixed` event
    // seen, which would render "Upgrade to >=1.8.5" — a downgrade.
    //
    // Use a non-real package to avoid noisy cache conflicts.
    const MULTI_RANGE_LOCK = [
      '{',
      '  "name": "test",',
      '  "version": "1.0.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "test", "version": "1.0.0" },',
      '    "node_modules/example": {',
      '      "version": "2.0.0"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const MULTI_RANGE_VULN: OsvVuln = {
      id: 'GHSA-multi-aaaa-bbbb',
      aliases: ['CVE-2024-00000'],
      summary: 'Issue affecting both 1.x and 2.x release lines',
      severity: [{ type: 'CVSS_V3', score: '7.5' }],
      affected: [
        {
          package: { name: 'example', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [{ introduced: '1.0.0' }, { fixed: '1.8.5' }],
            },
            {
              type: 'SEMVER',
              events: [{ introduced: '2.0.0' }, { fixed: '2.3.1' }],
            },
          ],
        },
      ],
    };
    const batchResp: OsvBatchResponse = {
      results: [{ vulns: [{ id: 'GHSA-multi-aaaa-bbbb', modified: '2024-01-01T00:00:00Z' }] }],
    };
    const osvClient: OsvClient = {
      queryBatch: vi.fn().mockResolvedValue(batchResp),
      getVuln: vi.fn().mockResolvedValue(MULTI_RANGE_VULN),
    };
    const reader: FileReader = {
      read: vi.fn().mockResolvedValue(MULTI_RANGE_LOCK),
    } as unknown as FileReader;
    const scanner = createDependencyCveScanner({ osvClient });

    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'package-lock.json' })],
        fileReader: reader,
      }),
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    if (finding.evidence.kind !== 'cve') throw new Error('expected cve evidence');
    // CRITICAL: must pick 2.3.1 (the 2.x line fix), NOT 1.8.5 (the 1.x fix).
    expect(finding.evidence.fixed_version).toBe('2.3.1');
    expect(finding.description).toContain('>=2.3.1');
    expect(finding.description).not.toContain('>=1.8.5');
  });
});
