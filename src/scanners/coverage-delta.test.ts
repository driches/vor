/**
 * Tests for the coverage-delta scanner.
 *
 * The scanner has four moving parts and the tests below exercise each in
 * isolation:
 *
 *   1. Tool detection (vitest / jest / pytest-cov / none) reading the workspace
 *   2. Parsing of the Istanbul-style `coverage-final.json` shape
 *   3. The per-line "is this statement uncovered?" predicate
 *   4. End-to-end `scan()` driven through dependency injection (so we never
 *      spawn a real coverage subprocess from the test suite)
 *
 * We test the public surface (`createCoverageDeltaScanner`, plus the exported
 * helpers `detectCoverageTool`, `uncoveredLines`) and use DI to short-circuit
 * the subprocess and JSON-loading paths.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import {
  createCoverageDeltaScanner,
  detectCoverageTool,
  uncoveredLines,
  type CoverageMap,
  type DetectedTool,
  type FileCoverage,
  type Logger,
} from './coverage-delta.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
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

/** Build a workspace under os.tmpdir() with a given set of files. Returns the
 *  workspace path. The caller is expected to use these paths inside a single
 *  test only — we don't clean them up because they're tiny (<1 KB total) and
 *  the OS will reap tmpdir on the next boot. */
function makeWorkspace(files: Record<string, string>): string {
  const ws = mkdtempSync(path.join(tmpdir(), 'cov-delta-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(ws, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
  return ws;
}

// -----------------------------------------------------------------
// applies()
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner — applies()', () => {
  it('returns true when at least one non-binary, non-generated file has added lines', () => {
    const scanner = createCoverageDeltaScanner();
    expect(
      scanner.applies([
        makeChangedFile({ is_binary: true, added_lines: new Set([1]) }),
        makeChangedFile({ added_lines: new Set([1, 2]) }),
      ]),
    ).toBe(true);
  });

  it('returns false when every changed file is binary, generated, or has no added lines', () => {
    const scanner = createCoverageDeltaScanner();
    expect(
      scanner.applies([
        makeChangedFile({ is_binary: true, added_lines: new Set([1]) }),
        makeChangedFile({ is_generated: true, added_lines: new Set([2]) }),
        makeChangedFile({ added_lines: new Set() }),
      ]),
    ).toBe(false);
  });

  it('returns false on an empty file list', () => {
    const scanner = createCoverageDeltaScanner();
    expect(scanner.applies([])).toBe(false);
  });
});

// -----------------------------------------------------------------
// detectCoverageTool — vitest
// -----------------------------------------------------------------

describe('detectCoverageTool — vitest', () => {
  it('detects vitest when package.json has scripts.coverage and vitest dep', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        scripts: { coverage: 'vitest run --coverage' },
        devDependencies: { vitest: '^4.0.0' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'src/foo.ts', added_lines: new Set([1]) })],
    });
    const out = detectCoverageTool(deps);
    expect(out).not.toBeNull();
    expect(out?.id).toBe('vitest');
    expect(out?.artifact.endsWith(path.join('coverage', 'coverage-final.json'))).toBe(true);
  });

  it('detects vitest when scripts["test:coverage"] is defined', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        scripts: { 'test:coverage': 'vitest run --coverage' },
        devDependencies: { vitest: '^4.0.0' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('vitest');
  });

  it('detects vitest when a vitest.config.ts file is present even without the dep listed', () => {
    // Monorepo case — root package.json may not list vitest but a workspace
    // config file is still authoritative.
    const ws = makeWorkspace({
      'package.json': JSON.stringify({ scripts: { coverage: 'vitest' } }),
      'vitest.config.ts': 'export default {};',
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('vitest');
  });

  it('does not detect vitest when no JS/TS file was added (Python-only PR)', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        scripts: { coverage: 'vitest' },
        devDependencies: { vitest: '^4.0.0' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'app/main.py', added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)).toBeNull();
  });
});

// -----------------------------------------------------------------
// detectCoverageTool — jest
// -----------------------------------------------------------------

describe('detectCoverageTool — jest', () => {
  it('detects jest when package.json declares it as a devDependency', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        devDependencies: { jest: '^29.0.0' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    const out = detectCoverageTool(deps);
    expect(out?.id).toBe('jest');
    expect(out?.artifact.endsWith(path.join('coverage', 'coverage-final.json'))).toBe(true);
  });

  it('detects jest when package.json has a `jest` config block', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        jest: { testEnvironment: 'node' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('jest');
  });

  it('detects jest when a jest.config.js file is present', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({ name: 'app' }),
      'jest.config.js': 'module.exports = {};',
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('jest');
  });

  it('prefers vitest when both vitest and jest are present (priority order)', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({
        scripts: { coverage: 'vitest' },
        devDependencies: { vitest: '^4.0.0', jest: '^29.0.0' },
      }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('vitest');
  });
});

// -----------------------------------------------------------------
// detectCoverageTool — pytest-cov
// -----------------------------------------------------------------

describe('detectCoverageTool — pytest-cov', () => {
  it('detects pytest-cov when pyproject.toml exists AND the PR touches a .py file', () => {
    const ws = makeWorkspace({
      'pyproject.toml': '[tool.pytest]\n',
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'app/main.py', added_lines: new Set([1]) })],
    });
    const out = detectCoverageTool(deps);
    expect(out?.id).toBe('pytest-cov');
    expect(out?.artifact.endsWith('coverage.json')).toBe(true);
  });

  it('detects pytest-cov when pytest.ini exists', () => {
    const ws = makeWorkspace({ 'pytest.ini': '[pytest]\n' });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'a.py', added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('pytest-cov');
  });

  it('detects pytest-cov when only conftest.py exists', () => {
    const ws = makeWorkspace({ 'conftest.py': '' });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'a.py', added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)?.id).toBe('pytest-cov');
  });

  it('does NOT detect pytest-cov when only non-Python files were added', () => {
    // pytest-cov requires both a Python project marker AND a .py change.
    // Skip the heavy run when the PR doesn't touch Python.
    const ws = makeWorkspace({
      'pyproject.toml': '[tool.pytest]\n',
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ path: 'docs/README.md', added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)).toBeNull();
  });
});

// -----------------------------------------------------------------
// detectCoverageTool — no-tool fallback
// -----------------------------------------------------------------

describe('detectCoverageTool — no-tool fallback', () => {
  it('returns null when the workspace has no package.json and no Python markers', () => {
    const ws = makeWorkspace({}); // empty workspace
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)).toBeNull();
  });

  it('returns null when package.json exists but no coverage tool is configured', () => {
    const ws = makeWorkspace({
      'package.json': JSON.stringify({ name: 'app' }),
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)).toBeNull();
  });

  it('returns null when package.json is malformed (defensive)', () => {
    const ws = makeWorkspace({
      'package.json': '{ this is not valid json',
    });
    const deps = makeScannerDeps({
      workspaceDir: ws,
      changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
    });
    expect(detectCoverageTool(deps)).toBeNull();
  });
});

// -----------------------------------------------------------------
// uncoveredLines — Istanbul shape parser + coverage logic
// -----------------------------------------------------------------

describe('uncoveredLines — Istanbul shape', () => {
  it('marks lines whose only statement has s[stmt] === 0 as uncovered', () => {
    // Istanbul shape for two single-line statements: line 5 ran once, line 6
    // did not run at all.
    const fc: FileCoverage = {
      statementMap: {
        '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
        '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 10 } },
      },
      s: { '0': 1, '1': 0 },
    };
    const out = uncoveredLines(fc);
    expect(out.has(5)).toBe(false);
    expect(out.has(6)).toBe(true);
  });

  it('treats a line as covered when ANY statement on that line was hit', () => {
    // Two statements on line 5; one hit, one not. The line as a whole is
    // covered — matches "at least one statement on that line has count > 0".
    const fc: FileCoverage = {
      statementMap: {
        '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 5 } },
        '1': { start: { line: 5, column: 6 }, end: { line: 5, column: 12 } },
      },
      s: { '0': 0, '1': 1 },
    };
    expect(uncoveredLines(fc).has(5)).toBe(false);
  });

  it('marks every line in a multi-line statement uncovered when that statement is uncovered', () => {
    // A single statement spanning lines 10..12 with zero hits → all three
    // lines should appear in the uncovered set.
    const fc: FileCoverage = {
      statementMap: {
        '0': { start: { line: 10, column: 0 }, end: { line: 12, column: 5 } },
      },
      s: { '0': 0 },
    };
    const out = uncoveredLines(fc);
    expect(out.has(10)).toBe(true);
    expect(out.has(11)).toBe(true);
    expect(out.has(12)).toBe(true);
  });

  it('returns an empty set for a fully covered file', () => {
    const fc: FileCoverage = {
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
        '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } },
      },
      s: { '0': 7, '1': 3 },
    };
    expect(uncoveredLines(fc).size).toBe(0);
  });

  it('tolerates malformed statementMap entries (defensive)', () => {
    // Missing/invalid entries shouldn't throw — the scanner must degrade
    // gracefully across coverage-tool quirks.
    const fc = {
      statementMap: {
        '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 5 } },
        '1': null,
        '2': { start: { line: 'not-a-number' as unknown as number }, end: { line: 5 } },
      },
      s: { '0': 0, '1': 0, '2': 0 },
    } as unknown as FileCoverage;
    const out = uncoveredLines(fc);
    expect(out.has(5)).toBe(true);
    expect(out.size).toBe(1);
  });
});

// -----------------------------------------------------------------
// scan() — happy path with DI
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner.scan — happy path', () => {
  it('emits one finding per uncovered added line, scoped to added_lines only', async () => {
    const file = makeChangedFile({
      path: 'src/foo.ts',
      added_lines: new Set([1, 2, 3]),
      reviewable_lines: [[1, 5]],
    });

    // Build a synthetic vitest coverage map: lines 1 and 3 are uncovered,
    // line 2 is covered, line 5 (NOT added) is uncovered but should be
    // ignored because it's not in `added_lines`.
    const coverage: CoverageMap = {
      'src/foo.ts': {
        statementMap: {
          '0': { start: { line: 1 }, end: { line: 1 } },
          '1': { start: { line: 2 }, end: { line: 2 } },
          '2': { start: { line: 3 }, end: { line: 3 } },
          '3': { start: { line: 5 }, end: { line: 5 } },
        },
        s: { '0': 0, '1': 1, '2': 0, '3': 0 },
      },
    };

    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => coverage,
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toHaveLength(2);
    const lines = result.findings.map((f) => f.line).sort();
    expect(lines).toEqual([1, 3]);
    const first = result.findings[0]!;
    expect(first.scanner).toBe('coverage-delta');
    expect(first.severity).toBe('minor');
    expect(first.category).toBe('test-gap');
    expect(first.confidence).toBe('medium');
    expect(first.rule_id).toBe('coverage:vitest:uncovered-line');
    expect(first.evidence.kind).toBe('coverage');
    if (first.evidence.kind !== 'coverage') throw new Error('unreachable');
    expect(first.evidence.tool).toBe('vitest');
    expect(first.fingerprint).toBe('coverage-delta:vitest:src/foo.ts:1');
    expect(result.errors).toEqual([]);
    expect(result.metrics.files_examined).toBe(1);
    expect(result.metrics.network_calls).toBe(0);
  });

  it('returns an empty result and an error when the CLI fails to produce coverage', async () => {
    const file = makeChangedFile({ added_lines: new Set([1]) });
    const tool: DetectedTool = {
      id: 'jest',
      artifact: '/tmp/coverage-final.json',
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: false, reason: 'subprocess crashed' }),
      loadCoverage: () => {
        throw new Error('should not be called');
      },
    });

    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));

    expect(result.findings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/did not produce coverage data/i);
    expect(result.errors[0]?.fatal).toBe(false);
  });

  it('returns an empty result when no tool is detected (quiet skip)', async () => {
    const scanner = createCoverageDeltaScanner({
      detectTool: () => null,
    });
    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
      }),
    );
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.metrics.files_examined).toBe(0);
  });
});

// -----------------------------------------------------------------
// scan() — failure isolation
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner.scan — failure isolation', () => {
  it('never throws when the CLI runner itself throws (defensive)', async () => {
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => {
        throw new Error('boom');
      },
    });
    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
      }),
    );
    expect(result.findings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/runner failed/i);
  });

  it('never throws when loadCoverage throws (degraded path)', async () => {
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => {
        throw new Error('corrupt JSON');
      },
    });
    const result = await scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ added_lines: new Set([1]) })],
      }),
    );
    expect(result.findings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.cause).toMatch(/corrupt JSON/);
  });

  it('uses the configured per-scanner timeout (240s) so coverage runs get a long budget', () => {
    const scanner = createCoverageDeltaScanner();
    expect(scanner.timeoutMs).toBe(240_000);
  });
});

// -----------------------------------------------------------------
// scan() — ignore-list integration
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner.scan — ignore-list integration', () => {
  it('suppresses findings the ignore-list matches', async () => {
    const file = makeChangedFile({
      path: 'src/foo.ts',
      added_lines: new Set([1]),
    });
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const coverage: CoverageMap = {
      'src/foo.ts': {
        statementMap: {
          '0': { start: { line: 1 }, end: { line: 1 } },
        },
        s: { '0': 0 },
      },
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => coverage,
    });
    const ignoreList = makeIgnoreList({ ignored: true });
    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], ignoreList }));
    expect(result.findings).toEqual([]);
    // ignoreList still was consulted — we don't want a silent skip.
    expect(ignoreList.matches).toHaveBeenCalledTimes(1);
  });

  it('logs a notice for expired ignore entries but still suppresses the finding', async () => {
    const file = makeChangedFile({
      path: 'src/foo.ts',
      added_lines: new Set([1]),
    });
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const coverage: CoverageMap = {
      'src/foo.ts': {
        statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
        s: { '0': 0 },
      },
    };
    const log = makeLogger();
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => coverage,
      logger: log,
    });
    const ignoreList = makeIgnoreList({
      ignored: true,
      expired: true,
      reason: 'TODO: cover this after refactor',
    });
    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file], ignoreList }));
    expect(result.findings).toEqual([]);
    expect(log.notice).toHaveBeenCalledTimes(1);
    expect(log.notice.mock.calls[0]![0]).toMatch(/expired/);
  });
});

// -----------------------------------------------------------------
// scan() — path normalization
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner.scan — path normalization', () => {
  it('matches a coverage report keyed by an absolute path against the relative changedFile path', async () => {
    // Istanbul reports often emit absolute paths (the path of the source
    // file at test-time, e.g. /work/repo/src/foo.ts). The scanner has to
    // re-relativize against the workspace so it can find the PR's
    // changedFile entry.
    const file = makeChangedFile({
      path: 'src/foo.ts',
      added_lines: new Set([5]),
    });
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/work/repo/coverage/coverage-final.json',
    };
    const coverage: CoverageMap = {
      '/work/repo/src/foo.ts': {
        statementMap: { '0': { start: { line: 5 }, end: { line: 5 } } },
        s: { '0': 0 },
      },
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => coverage,
    });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [file], workspaceDir: '/work/repo' }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file_path).toBe('src/foo.ts');
    expect(result.findings[0]?.line).toBe(5);
  });
});

// -----------------------------------------------------------------
// scan() — context-line gate (added_lines, not reviewable_lines)
// -----------------------------------------------------------------

describe('createCoverageDeltaScanner.scan — context-line gate', () => {
  it('skips uncovered lines that are only in reviewable_lines (context, not added)', async () => {
    // The PR adds line 5 and has line 4 as context. The coverage tool
    // reports BOTH as uncovered, but the scanner should only flag line 5
    // because line 4 pre-existed (its lack of coverage isn't a regression).
    const file = makeChangedFile({
      path: 'src/foo.ts',
      added_lines: new Set([5]),
      reviewable_lines: [[3, 6]],
    });
    const tool: DetectedTool = {
      id: 'vitest',
      artifact: '/tmp/coverage-final.json',
    };
    const coverage: CoverageMap = {
      'src/foo.ts': {
        statementMap: {
          '0': { start: { line: 4 }, end: { line: 4 } },
          '1': { start: { line: 5 }, end: { line: 5 } },
        },
        s: { '0': 0, '1': 0 },
      },
    };
    const scanner = createCoverageDeltaScanner({
      detectTool: () => tool,
      runCli: async () => ({ ok: true }),
      loadCoverage: () => coverage,
    });
    const result = await scanner.scan(makeScannerDeps({ changedFiles: [file] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(5);
  });
});
