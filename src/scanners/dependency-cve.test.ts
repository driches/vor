/**
 * Tests for the dependency-cve scanner.
 *
 * Covers the public `createDependencyCveScanner({ osvClient, parsers, logger })`
 * factory: applies/scan contract, OSV happy path, cache dedup across two
 * lockfiles, network-failure degradation, ignore-list integration (including
 * the expired-suppression notice), suggestion fix-version mapping, parser
 * no-match, and severity-bucket mapping from CVSS.
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
  return {
    path: 'package-lock.json',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
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

    // Suggestion mentions the fixed version.
    expect(finding.suggestion).toContain('>=4.17.12');

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

describe('createDependencyCveScanner — suggestion fixed-version mapping', () => {
  it("renders the suggestion as 'Upgrade <pkg> to >=<fixed>'", async () => {
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
    expect(result.findings[0]!.suggestion).toBe('Upgrade lodash to >=4.17.12.');
    if (result.findings[0]!.evidence.kind !== 'cve') {
      throw new Error('expected cve evidence');
    }
    expect(result.findings[0]!.evidence.fixed_version).toBe('4.17.12');
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
// Severity mapping from CVSS
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
