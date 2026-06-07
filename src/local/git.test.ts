import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedFiles,
  fileContentAtRef,
  fileContentOnDisk,
  hasWorkingTreeChanges,
  resolveRef,
  unifiedDiff,
} from './git.js';

function g(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

describe('local git helpers', () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vor-git-'));
    g(repo, ['init', '-q']);
    g(repo, ['config', 'user.email', 'test@example.com']);
    g(repo, ['config', 'user.name', 'Test']);
    g(repo, ['config', 'commit.gpgsign', 'false']);

    writeFileSync(join(repo, 'keep.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'drop.ts'), 'export const gone = true;\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'first commit']);
    baseSha = resolveRef(repo, 'HEAD');

    writeFileSync(join(repo, 'keep.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'added.ts'), 'export const b = 3;\n');
    rmSync(join(repo, 'drop.ts'));
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'second commit']);
    headSha = resolveRef(repo, 'HEAD');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('enumerates added/modified/removed files for a range', () => {
    const files = changedFiles(repo, [`${baseSha}..${headSha}`]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]));
    expect(byPath['keep.ts']).toBe('modified');
    expect(byPath['added.ts']).toBe('added');
    expect(byPath['drop.ts']).toBe('removed');
  });

  it('builds a unified diff with hunks', () => {
    const diff = unifiedDiff(repo, [`${baseSha}..${headSha}`]);
    expect(diff).toContain('+export const a = 2;');
    expect(diff).toContain('added.ts');
  });

  it('reads content at a ref and from disk', () => {
    expect(fileContentAtRef(repo, baseSha, 'keep.ts')).toBe('export const a = 1;\n');
    expect(fileContentAtRef(repo, headSha, 'drop.ts')).toBeNull();
    expect(fileContentOnDisk(repo, 'keep.ts')).toBe('export const a = 2;\n');
    expect(fileContentOnDisk(repo, 'nope.ts')).toBeNull();
  });

  it('detects working-tree changes and diffs HEAD vs disk', () => {
    expect(hasWorkingTreeChanges(repo)).toBe(false);
    writeFileSync(join(repo, 'keep.ts'), 'export const a = 99;\n');
    expect(hasWorkingTreeChanges(repo)).toBe(true);
    const wtFiles = changedFiles(repo, ['HEAD']);
    expect(wtFiles.map((f) => f.path)).toContain('keep.ts');
    expect(unifiedDiff(repo, ['HEAD'])).toContain('+export const a = 99;');
    // restore so the suite is order-independent
    writeFileSync(join(repo, 'keep.ts'), 'export const a = 2;\n');
    expect(hasWorkingTreeChanges(repo)).toBe(false);
  });
});
