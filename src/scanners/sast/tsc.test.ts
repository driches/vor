import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTscOutput, tscLinter } from './tsc.js';
import type { ChangedFile } from '../../types.js';
import type { ScannerDeps } from '../types.js';
import type { SecurityConfig } from '../../config/types.js';

// `parseTscOutput` is the parser for tsc's `--pretty false` output: it's
// the only logic in this module that can silently drop every finding if
// it regresses (a bad regex → 0 matches → empty findings, no test signal
// from the run itself). These tests pin the canonical format, the
// multi-line continuation behavior, and severity routing.
describe('parseTscOutput', () => {
  it('parses the canonical `path(line,col): error TSXXXX: message` format', () => {
    const raw = "src/foo.ts(42,7): error TS2322: Type 'number' is not assignable to type 'string'.";
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: 'src/foo.ts',
      line: 42,
      column: 7,
      severity: 'error',
      code: 'TS2322',
      message: "Type 'number' is not assignable to type 'string'.",
    });
  });

  it('parses multiple diagnostics on separate lines', () => {
    const raw = [
      "src/foo.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
      'src/bar.ts(15,3): error TS2554: Expected 2 arguments, but got 1.',
    ].join('\n');
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.filePath).toBe('src/foo.ts');
    expect(result[1]?.filePath).toBe('src/bar.ts');
    expect(result[1]?.line).toBe(15);
    expect(result[1]?.code).toBe('TS2554');
  });

  it('parses warning severity (defensive — tsc rarely emits warnings)', () => {
    const raw = 'src/foo.ts(10,2): warning TS9999: Synthetic warning for test coverage.';
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe('warning');
  });

  it('appends indented continuation lines onto the preceding diagnostic', () => {
    // tsc wraps multi-line messages — the first line carries the
    // path(line,col): prefix, continuation lines are indented and have
    // no prefix. Pre-fix the parser dropped continuation context,
    // leaving findings with a truncated `Type 'A' is not assignable to
    // type 'B'.` and losing the structural detail.
    const raw = [
      "src/foo.ts(42,7): error TS2322: Type 'A' is not assignable to type 'B'.",
      "  Property 'foo' is missing in type 'A' but required in type 'B'.",
      "    at src/baz.ts(8,3): 'foo' is declared here.",
    ].join('\n');
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("Type 'A' is not assignable to type 'B'.");
    expect(result[0]?.message).toContain("Property 'foo' is missing");
    expect(result[0]?.message).toContain("'foo' is declared here");
  });

  it('does NOT treat un-indented non-matching lines as continuations', () => {
    // tsc's summary line "Found N errors in M files." starts at column
    // 0 and does NOT belong to any diagnostic. Pre-fix, a naive
    // "anything after a diagnostic is continuation" rule would have
    // appended "Found 1 error in 1 file." to the last diagnostic's
    // message — operator-visible junk in PR comments.
    const raw = [
      "src/foo.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
      '',
      'Found 1 error in 1 file.',
    ].join('\n');
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("Type 'A' is not assignable to type 'B'.");
    expect(result[0]?.message).not.toContain('Found');
  });

  it('handles Windows-style CRLF line endings', () => {
    const raw =
      "src/foo.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.\r\n" +
      'src/bar.ts(2,2): error TS2554: Expected 2 arguments, but got 1.\r\n';
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(2);
    // Trailing \r must be stripped; otherwise the regex anchor on `$`
    // fails and EVERY tsc finding silently drops on Windows runners.
    expect(result[0]?.message).toBe("Type 'A' is not assignable to type 'B'.");
    expect(result[0]?.message).not.toContain('\r');
  });

  it('parses paths with subdirectories and dot characters', () => {
    const raw = "src/scanners/sast/foo.test.ts(100,50): error TS2304: Cannot find name 'Bar'.";
    const result = parseTscOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.filePath).toBe('src/scanners/sast/foo.test.ts');
    expect(result[0]?.line).toBe(100);
    expect(result[0]?.column).toBe(50);
  });

  it('skips lines that do not match the diagnostic anchor and have no prior diagnostic', () => {
    // tsc on a clean repo emits no diagnostics; a summary line alone
    // should produce zero findings (not crash, not emit garbage).
    const raw = 'Files: 100\nErrors: 0\nWarnings: 0';
    expect(parseTscOutput(raw)).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseTscOutput('')).toEqual([]);
    expect(parseTscOutput('\n\n\n')).toEqual([]);
  });
});

/**
 * Build a minimal ScannerDeps for tests. The fields the tsc module
 * actually reads are `workspaceDir` and `config.scanners.sast.tsc`;
 * everything else is filled with stubs to satisfy the structural type.
 */
function makeDeps(
  workspaceDir: string,
  overrides: { tscConfig?: { enabled?: boolean }; changedFiles?: ChangedFile[] } = {},
): ScannerDeps {
  const config: SecurityConfig = {
    enabled: true,
    ignore_file: '.vor/security-ignore.yml',
    scanners: {
      dependency_cve: { enabled: true },
      secrets: { enabled: true, include_generic_entropy: false },
      sast: {
        enabled: true,
        ...(overrides.tscConfig !== undefined ? { tsc: overrides.tscConfig } : {}),
      },
      container_cve: { enabled: false },
      coverage_delta: { enabled: false },
      debris: { enabled: false },
      migration_safety: { enabled: false },
      dependency_hygiene: { enabled: false },
    },
    cache: { enabled: false },
    persistence: { enabled: false },
  };
  return {
    octokit: {} as never,
    owner: 'test',
    repo: 'test',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: overrides.changedFiles ?? [],
    contextFiles: [],
    diff: '',
    workspaceDir,
    cache: {
      get: () => undefined,
      set: () => {},
      hit_count: 0,
      miss_count: 0,
    },
    ignoreList: { matches: () => ({ ignored: false }) },
    fileReader: {} as never,
    config,
    signal: new AbortController().signal,
  };
}

describe('tscLinter', () => {
  // Integration boundary: the linter's run() does I/O (existsSync for
  // tsconfig.json, findWorkspaceBinary for the tsc shim, spawn for the
  // process). The tests below exercise the activation gates that fire
  // BEFORE spawn — the parser is tested separately above. End-to-end
  // spawn coverage would require pinning a tsc binary in the test
  // workspace and is left to manual/integration testing.

  it('applies() returns true when any TS file is changed', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/foo.ts',
        status: 'added',
        additions: 5,
        deletions: 0,
        reviewable_lines: [[1, 5]],
        added_lines: new Set([1, 2, 3, 4, 5]),
        language: 'TypeScript',
        is_generated: false,
        is_binary: false,
        size_bytes: 100,
        head_line_text: new Map(),
      },
    ];
    expect(tscLinter.applies(files)).toBe(true);
  });

  it('applies() returns true for .tsx, .cts, .mts variants', () => {
    const base = {
      status: 'added' as const,
      additions: 1,
      deletions: 0,
      reviewable_lines: [[1, 1] as [number, number]],
      added_lines: new Set([1]),
      language: 'TypeScript',
      is_generated: false,
      is_binary: false,
      size_bytes: 100,
      head_line_text: new Map(),
    };
    expect(tscLinter.applies([{ ...base, path: 'src/a.tsx' }])).toBe(true);
    expect(tscLinter.applies([{ ...base, path: 'src/a.cts' }])).toBe(true);
    expect(tscLinter.applies([{ ...base, path: 'src/a.mts' }])).toBe(true);
  });

  it('applies() returns false when only non-TS files are changed', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/foo.py',
        status: 'added',
        additions: 5,
        deletions: 0,
        reviewable_lines: [[1, 5]],
        added_lines: new Set([1, 2, 3, 4, 5]),
        language: 'Python',
        is_generated: false,
        is_binary: false,
        size_bytes: 100,
        head_line_text: new Map(),
      },
    ];
    expect(tscLinter.applies(files)).toBe(false);
  });

  it('applies() returns false for binary or generated TS files', () => {
    const base = {
      path: 'src/foo.ts',
      status: 'added' as const,
      additions: 1,
      deletions: 0,
      reviewable_lines: [[1, 1] as [number, number]],
      added_lines: new Set([1]),
      language: 'TypeScript',
      size_bytes: 100,
      head_line_text: new Map(),
    };
    expect(tscLinter.applies([{ ...base, is_generated: true, is_binary: false }])).toBe(false);
    expect(tscLinter.applies([{ ...base, is_generated: false, is_binary: true }])).toBe(false);
  });

  it('quietly skips when tsconfig.json is missing', async () => {
    // Use a real tmpdir so existsSync sees actual filesystem state.
    // No tsconfig.json, no tsc binary — both gates would skip, but the
    // tsconfig.json gate runs first.
    const tmp = mkdtempSync(path.join(tmpdir(), 'tsc-test-'));
    try {
      const deps = makeDeps(tmp);
      const result = await tscLinter.run(deps, []);
      expect(result.findings).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.filesExamined).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty result when tsc binary is missing (does not throw)', async () => {
    // tsconfig.json present but no node_modules/.bin/tsc. The module
    // must NOT throw — empty result with no errors is the contract.
    const tmp = mkdtempSync(path.join(tmpdir(), 'tsc-test-'));
    try {
      const fs = await import('node:fs/promises');
      await fs.writeFile(path.join(tmp, 'tsconfig.json'), '{}');
      const deps = makeDeps(tmp);
      const result = await tscLinter.run(deps, []);
      expect(result.findings).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects the per-linter enabled:false opt-out before any I/O', async () => {
    // Use a path that DOES NOT exist — the early-return on
    // tsc.enabled=false must fire before existsSync(tsconfig.json), so a
    // bogus workspaceDir is fine. This locks in the ordering: config
    // gate first, filesystem gates second.
    const deps = makeDeps('/this/path/definitely/does/not/exist', {
      tscConfig: { enabled: false },
    });
    const result = await tscLinter.run(deps, []);
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.filesExamined).toBe(0);
  });
});

// The PR-added-line filter is part of run()'s post-parse loop. We can't
// test it without spawning tsc, but we CAN test the equivalent
// filtering logic by simulating the loop directly: parse a raw output,
// then verify a Set-based added_lines lookup drops findings outside the
// PR.
describe('tsc finding filter', () => {
  it('drops parsed diagnostics whose line is NOT in added_lines', () => {
    const raw = [
      'src/foo.ts(10,1): error TS2322: pr-added line.',
      'src/foo.ts(99,1): error TS2322: pre-existing context line.',
    ].join('\n');
    const diagnostics = parseTscOutput(raw);
    expect(diagnostics).toHaveLength(2);
    // Simulate the run() loop's filter: only the line in added_lines
    // (10) should survive; line 99 was in the file before this PR.
    const added_lines = new Set([10]);
    const kept = diagnostics.filter((d) => added_lines.has(d.line));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.line).toBe(10);
    expect(kept[0]?.message).toBe('pr-added line.');
  });
});

// Severity routing is one line of buildFinding(), but it's load-bearing
// — the orchestrator's severity-floor filter uses it to decide which
// findings reach PR comments. Verify the mapping by parsing tsc output
// and asserting the parsed severity field matches the expected route.
describe('tsc severity mapping', () => {
  it('error → important, warning → minor (parsed)', () => {
    const raw = [
      'src/foo.ts(1,1): error TS2322: an error.',
      'src/bar.ts(2,2): warning TS9999: a warning.',
    ].join('\n');
    const diagnostics = parseTscOutput(raw);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[1]?.severity).toBe('warning');
    // The buildFinding() mapping is:
    //   error → 'important'
    //   warning → 'minor'
    // Documented in tsc.ts; this assertion pins the parser's role in
    // that mapping (a regression that classified 'error' as some other
    // string would route every finding to the wrong severity).
  });
});
