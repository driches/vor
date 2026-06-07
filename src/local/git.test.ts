import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorFromHead,
  bodyFromHead,
  changedFiles,
  fileContentAtRef,
  fileContentOnDisk,
  hasWorkingTreeChanges,
  repoRoot,
  resolveRef,
  titleFromHead,
  unifiedDiff,
  untrackedFiles,
  workingTreeChanges,
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

  it('refuses on-disk reads that escape the workspace', () => {
    // A model-supplied path must not traverse out of the checkout.
    const secret = join(repo, '..', 'escape-secret.txt');
    writeFileSync(secret, 'top secret\n');
    try {
      expect(fileContentOnDisk(repo, '../escape-secret.txt')).toBeNull();
      expect(fileContentOnDisk(repo, '../../etc/hostname')).toBeNull();
      expect(fileContentOnDisk(repo, '/etc/hostname')).toBeNull();
      // A normal nested path inside the repo still reads.
      mkdirSync(join(repo, 'sub'), { recursive: true });
      writeFileSync(join(repo, 'sub', 'in.ts'), 'inside\n');
      expect(fileContentOnDisk(repo, 'sub/in.ts')).toBe('inside\n');
    } finally {
      rmSync(secret, { force: true });
      rmSync(join(repo, 'sub'), { recursive: true, force: true });
    }
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

  it('includes untracked new files in working-tree changes', () => {
    writeFileSync(join(repo, 'brand-new.ts'), 'export const secret = "x";\n');
    try {
      // An untracked-only change still counts as a working-tree change.
      expect(hasWorkingTreeChanges(repo)).toBe(true);
      expect(untrackedFiles(repo)).toContain('brand-new.ts');

      const { files, diff } = workingTreeChanges(repo);
      const newFile = files.find((f) => f.path === 'brand-new.ts');
      expect(newFile).toBeDefined();
      expect(newFile!.status).toBe('added');
      expect(newFile!.additions).toBe(1);
      expect(diff).toContain('+++ b/brand-new.ts');
      expect(diff).toContain('+export const secret = "x";');
    } finally {
      rmSync(join(repo, 'brand-new.ts'));
    }
  });

  it('resolves a subdirectory to the repository root', () => {
    mkdirSync(join(repo, 'pkg', 'nested'), { recursive: true });
    // Both the root and a nested dir resolve to the same top-level.
    expect(repoRoot(join(repo, 'pkg', 'nested'))).toBe(repoRoot(repo));
    // A non-repo path falls back to itself rather than throwing.
    const outside = mkdtempSync(join(tmpdir(), 'vor-norepo-'));
    try {
      expect(repoRoot(outside)).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads PR metadata from an explicit ref, not just the checkout', () => {
    // Default reads HEAD (the second commit); an explicit base ref reads the
    // first. Range reviews rely on this to describe the requested head when a
    // different commit is checked out.
    expect(titleFromHead(repo)).toBe('second commit');
    expect(titleFromHead(repo, baseSha)).toBe('first commit');
    expect(authorFromHead(repo, baseSha)).toBe('Test');
    expect(bodyFromHead(repo, baseSha)).toBe('');
  });
});
