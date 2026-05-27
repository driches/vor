/**
 * Tests for the dependency-hygiene scanner — lockfile drift, non-registry
 * sources, and unpinned version ranges in package.json.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile, LineRange } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createDependencyHygieneScanner } from './dependency-hygiene.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'package.json',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'json',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

/**
 * Build a package.json ChangedFile from its source lines, marking `addedLines`
 * (1-indexed) as added. The same text is what the FileReader mock will return,
 * so JSON.parse sees the same content the line map describes.
 */
function makeManifest(
  lines: readonly string[],
  addedLines: readonly number[],
  over: Partial<ChangedFile> = {},
): { file: ChangedFile; content: string } {
  const text = new Map<number, string>();
  for (let i = 0; i < lines.length; i += 1) text.set(i + 1, lines[i]!);
  const ranges: LineRange[] = lines.length > 0 ? [[1, lines.length]] : [];
  const file = makeChangedFile({
    path: 'package.json',
    head_line_text: text,
    reviewable_lines: ranges,
    added_lines: new Set(addedLines),
    ...over,
  });
  return { file, content: lines.join('\n') };
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
}

function makeScannerDeps(content: string | null, over: Partial<ScannerDeps> = {}): ScannerDeps {
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
    fileReader: { read: vi.fn().mockResolvedValue(content) } as unknown as FileReader,
    config: {} as unknown as SecurityConfig,
    signal: new AbortController().signal,
    ...over,
  };
}

const MANIFEST_LINES = [
  '{',
  '  "name": "demo",',
  '  "version": "1.0.0",',
  '  "dependencies": {',
  '    "lodash": "^4.17.21",',
  '    "evil": "git+https://example.com/evil.git",',
  '    "loose": "*"',
  '  }',
  '}',
];

describe('createDependencyHygieneScanner — applies()', () => {
  it('matches a changed package.json', () => {
    expect(createDependencyHygieneScanner().applies([makeChangedFile()])).toBe(true);
  });

  it('does not match other files', () => {
    expect(
      createDependencyHygieneScanner().applies([makeChangedFile({ path: 'src/app.ts' })]),
    ).toBe(false);
  });
});

describe('createDependencyHygieneScanner — scan()', () => {
  it('flags a non-registry source, an unpinned range, and lockfile drift', async () => {
    const { file, content } = makeManifest(MANIFEST_LINES, [5, 6, 7]);
    const deps = makeScannerDeps(content, { changedFiles: [file] });
    const result = await createDependencyHygieneScanner().scan(deps);

    const rules = result.findings.map((f) => f.rule_id);
    expect(rules).toContain('dependency-hygiene:non-registry-source');
    expect(rules).toContain('dependency-hygiene:unpinned-range');
    expect(rules).toContain('dependency-hygiene:lockfile-drift');
    // The normal caret range on lodash produces no per-dep finding.
    expect(
      result.findings.filter(
        (f) => f.evidence.kind === 'dependency' && f.evidence.package === 'lodash',
      ),
    ).toHaveLength(0);
  });

  it('does not flag lockfile drift when a lockfile is also changed', async () => {
    const { file, content } = makeManifest(MANIFEST_LINES, [5, 6, 7]);
    const lock = makeChangedFile({ path: 'package-lock.json', language: 'json' });
    const deps = makeScannerDeps(content, { changedFiles: [file, lock] });
    const result = await createDependencyHygieneScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).not.toContain(
      'dependency-hygiene:lockfile-drift',
    );
    // The dep-spec findings still fire.
    expect(result.findings.map((f) => f.rule_id)).toContain(
      'dependency-hygiene:non-registry-source',
    );
  });

  it('does not flag dependency lines that are unchanged (not added)', async () => {
    // Only the version line (3) is added — no dependency lines changed.
    const { file, content } = makeManifest(MANIFEST_LINES, [3]);
    const deps = makeScannerDeps(content, { changedFiles: [file] });
    const result = await createDependencyHygieneScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });

  it('does not misclassify the package version as a dependency', async () => {
    // version "1.0.0" is on an added line but is not in any dependency map.
    const { file, content } = makeManifest(MANIFEST_LINES, [3, 5]);
    const deps = makeScannerDeps(content, { changedFiles: [file] });
    const result = await createDependencyHygieneScanner().scan(deps);
    // lodash (line 5) is a normal range → only the drift finding (deps changed,
    // no lockfile) should appear; no spec findings for version/lodash.
    expect(result.findings.map((f) => f.rule_id)).toEqual(['dependency-hygiene:lockfile-drift']);
  });

  it('records a non-fatal error path gracefully on malformed JSON', async () => {
    const { file } = makeManifest(['{ not json'], [1]);
    const deps = makeScannerDeps('{ not json', { changedFiles: [file] });
    const result = await createDependencyHygieneScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
    expect(result.errors).toHaveLength(0); // parse failure is a quiet skip, not an error
  });

  it('suppresses findings matched by the ignore-list', async () => {
    const { file, content } = makeManifest(MANIFEST_LINES, [5, 6, 7]);
    const deps = makeScannerDeps(content, {
      changedFiles: [file],
      ignoreList: makeIgnoreList({ ignored: true }),
    });
    const result = await createDependencyHygieneScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });
});
