/**
 * Tests for the debris scanner — merge-conflict markers, focused tests,
 * debugger/breakpoint statements, and stray console logging on PR-added lines.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile, LineRange } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createDebrisScanner } from './debris.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

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

/** Map each line of `lines` to its number (1-indexed) and mark them all added. */
function makeFileWithLines(
  path_: string,
  lines: readonly string[],
  over: Partial<ChangedFile> = {},
): ChangedFile {
  const text = new Map<number, string>();
  const added = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    text.set(i + 1, lines[i]!);
    added.add(i + 1);
  }
  const ranges: LineRange[] = lines.length > 0 ? [[1, lines.length]] : [];
  return makeChangedFile({
    path: path_,
    head_line_text: text,
    reviewable_lines: ranges,
    added_lines: added,
    ...over,
  });
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
}

function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    octokit: {} as Octokit,
    owner: 'o',
    repo: 'r',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: [],
    contextFiles: [],
    diff: '',
    workspaceDir: '/tmp',
    cache: new InMemoryScanCache(),
    ignoreList: makeIgnoreList(),
    fileReader: { read: vi.fn().mockResolvedValue(null) } as unknown as FileReader,
    config: {} as unknown as SecurityConfig,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('createDebrisScanner — applies()', () => {
  it('returns true for an ordinary source file', () => {
    expect(createDebrisScanner().applies([makeChangedFile()])).toBe(true);
  });

  it('returns false when every file is binary or generated', () => {
    const files = [
      makeChangedFile({ path: 'a.png', is_binary: true }),
      makeChangedFile({ path: 'b.ts', is_generated: true }),
    ];
    expect(createDebrisScanner().applies(files)).toBe(false);
  });
});

describe('createDebrisScanner — scan()', () => {
  it('flags an unresolved merge-conflict marker as critical', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/foo.ts', ['<<<<<<< HEAD'])],
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule_id).toBe('debris:merge-conflict');
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('flags a focused test (.only)', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/foo.test.ts', ["describe.only('x', () => {})"])],
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain('debris:focused-test');
  });

  it('flags a leftover debugger statement', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/foo.ts', ['  debugger;'])],
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain('debris:debugger');
  });

  it('flags a Python breakpoint() call', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/app.py', ['    breakpoint()'])],
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain('debris:python-debugger');
  });

  it('flags console.log in non-test code but NOT in a test file', async () => {
    const nonTest = await createDebrisScanner().scan(
      makeScannerDeps({
        changedFiles: [makeFileWithLines('src/foo.ts', ['console.log("hi")'])],
      }),
    );
    expect(nonTest.findings.map((f) => f.rule_id)).toContain('debris:console-log');

    const test = await createDebrisScanner().scan(
      makeScannerDeps({
        changedFiles: [makeFileWithLines('src/foo.test.ts', ['console.log("hi")'])],
      }),
    );
    expect(test.findings.map((f) => f.rule_id)).not.toContain('debris:console-log');
  });

  it('ignores debris on context lines (only scans added lines)', async () => {
    // Line present in head_line_text but NOT in added_lines — pre-existing.
    const file = makeChangedFile({
      path: 'src/foo.ts',
      head_line_text: new Map([[10, '  debugger;']]),
      reviewable_lines: [[10, 10]],
      added_lines: new Set(),
    });
    const result = await createDebrisScanner().scan(makeScannerDeps({ changedFiles: [file] }));
    expect(result.findings).toHaveLength(0);
  });

  it('skips binary and generated files', async () => {
    const deps = makeScannerDeps({
      changedFiles: [
        makeFileWithLines('a.min.js', ['debugger;'], { is_generated: true }),
        makeFileWithLines('b.bin', ['<<<<<<< HEAD'], { is_binary: true }),
      ],
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });

  it('suppresses findings matched by the ignore-list', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/foo.ts', ['  debugger;'])],
      ignoreList: makeIgnoreList({ ignored: true }),
    });
    const result = await createDebrisScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });
});
