import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBlastRadius } from './blast-radius.js';
import type { ChangedFile } from '../types.js';

/**
 * Build a ChangedFile whose added lines carry the given source text, so the
 * symbol extractor sees the declaration. Mirrors what pr-context produces.
 */
function changedFile(
  path: string,
  addedText: string[],
  over: Partial<ChangedFile> = {},
): ChangedFile {
  const added_lines = new Set<number>();
  const head_line_text = new Map<number, string>();
  addedText.forEach((text, i) => {
    const lineNo = i + 1;
    added_lines.add(lineNo);
    head_line_text.set(lineNo, text);
  });
  return {
    path,
    status: 'modified',
    additions: addedText.length,
    deletions: 0,
    reviewable_lines: [[1, addedText.length]],
    added_lines,
    language: inferLanguage(path),
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text,
    ...over,
  };
}

function inferLanguage(path: string): string {
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.go')) return 'go';
  return 'typescript';
}

describe('computeBlastRadius', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vor-blast-'));
    // A defining file plus referencing files across the repo.
    writeFileSync(
      join(repo, 'auth.ts'),
      'export function verifyToken(t: string) {\n  return t.length > 0;\n}\n',
    );
    mkdirSync(join(repo, 'routes'), { recursive: true });
    writeFileSync(
      join(repo, 'routes', 'login.ts'),
      "import { verifyToken } from '../auth.js';\nverifyToken(req.token);\n",
    );
    writeFileSync(
      join(repo, 'routes', 'session.ts'),
      "import { verifyToken } from '../auth.js';\nif (!verifyToken(t)) throw new Error('no');\n",
    );
    // A symbol with no external callers.
    writeFileSync(join(repo, 'util.ts'), 'export function loneHelper() {\n  return 42;\n}\n');
    // A symbol whose legal JS name contains a regex metacharacter (`$`). Under
    // `git grep -E` the `$` would be an anchor and find nothing; the pre-pass
    // must match it literally.
    writeFileSync(join(repo, 'http.ts'), 'export const $httpClient = makeClient();\n');
    writeFileSync(
      join(repo, 'routes', 'fetch.ts'),
      "import { $httpClient } from '../http.js';\n$httpClient.get('/x');\n",
    );
    // Build artifact + prose references must be filtered out as non-call-sites.
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'index.js'), 'function verifyToken(t){return t}\n');
    writeFileSync(join(repo, 'CHANGELOG.md'), '- verifyToken now stricter\n');
    // Python + Go definitions for the multi-language extraction test.
    writeFileSync(repo + '/handlers.py', 'def process_payment(amount):\n    return amount\n');
    writeFileSync(
      repo + '/caller.py',
      'from handlers import process_payment\nprocess_payment(10)\n',
    );
    writeFileSync(repo + '/svc.go', 'package svc\nfunc ChargeCard() error { return nil }\n');
    writeFileSync(
      repo + '/main.go',
      'package main\nimport "x/svc"\nfunc main() { svc.ChargeCard() }\n',
    );

    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('finds external callers of a changed TS export', async () => {
    const map = await computeBlastRadius({
      changedFiles: [changedFile('auth.ts', ['export function verifyToken(t: string) {'])],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    const entry = map.entries.find((e) => e.symbol === 'verifyToken');
    expect(entry).toBeDefined();
    expect(entry!.defined_in).toBe('auth.ts');
    expect(entry!.reference_count).toBe(2);
    const refPaths = entry!.referenced_by.map((r) => r.path).sort();
    expect(refPaths).toEqual(['routes/login.ts', 'routes/session.ts']);
    // The defining file is never listed as its own caller.
    expect(refPaths).not.toContain('auth.ts');
    // Build artifacts and prose are not call sites.
    expect(refPaths).not.toContain('dist/index.js');
    expect(refPaths).not.toContain('CHANGELOG.md');
  });

  it('matches symbols containing regex metacharacters like $ (fixed-string grep)', async () => {
    const map = await computeBlastRadius({
      changedFiles: [changedFile('http.ts', ['export const $httpClient = makeClient();'])],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    const entry = map.entries.find((e) => e.symbol === '$httpClient');
    expect(entry).toBeDefined();
    expect(entry!.referenced_by.map((r) => r.path)).toContain('routes/fetch.ts');
  });

  it('omits a symbol that has no external references', async () => {
    const map = await computeBlastRadius({
      changedFiles: [changedFile('util.ts', ['export function loneHelper() {'])],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    expect(map.entries.find((e) => e.symbol === 'loneHelper')).toBeUndefined();
  });

  it('extracts Python def and Go exported func symbols', async () => {
    const map = await computeBlastRadius({
      changedFiles: [
        changedFile('handlers.py', ['def process_payment(amount):']),
        changedFile('svc.go', ['func ChargeCard() error { return nil }']),
      ],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    expect(map.entries.find((e) => e.symbol === 'process_payment')).toBeDefined();
    expect(map.entries.find((e) => e.symbol === 'ChargeCard')).toBeDefined();
  });

  it('skips generic / too-short symbol names', async () => {
    const map = await computeBlastRadius({
      // `id` (too short) and `config` (generic denylist) must not be looked up.
      changedFiles: [changedFile('x.ts', ['export const id = 1;', 'export const config = {};'])],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    expect(map.entries).toHaveLength(0);
  });

  it('caps referenced_by at maxRefsPerSymbol and flags truncation', async () => {
    const map = await computeBlastRadius({
      changedFiles: [changedFile('auth.ts', ['export function verifyToken(t: string) {'])],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 1,
    });
    const entry = map.entries.find((e) => e.symbol === 'verifyToken');
    expect(entry!.referenced_by).toHaveLength(1);
    expect(entry!.reference_count).toBe(2);
    expect(map.truncated).toBe(true);
  });

  it('degrades to an empty map when the workspace is not a git checkout', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'vor-nogit-'));
    try {
      const map = await computeBlastRadius({
        changedFiles: [changedFile('auth.ts', ['export function verifyToken(t: string) {'])],
        workspaceDir: nonGit,
        maxSymbols: 30,
        maxRefsPerSymbol: 8,
      });
      expect(map.entries).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('ignores generated and removed files when collecting symbols', async () => {
    const map = await computeBlastRadius({
      changedFiles: [
        changedFile('auth.ts', ['export function verifyToken(t: string) {'], {
          is_generated: true,
        }),
      ],
      workspaceDir: repo,
      maxSymbols: 30,
      maxRefsPerSymbol: 8,
    });
    expect(map.entries).toHaveLength(0);
  });
});
