/**
 * Unit tests for buildLocalDeps + LocalFileReader. We build a self-contained
 * synthetic case directory (no fixtures, no private code) and exercise the
 * full read path including the git checkout used by `read_file_at_ref`.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLocalDeps, loadContextFilesForCase } from './local-deps.js';

let caseDir: string;
let headSha: string;
let baseSha: string;

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
 export function existing() {
   return 1;
 }
+
+export const NEW = 42;
`;

function git(repoDir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e.x', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e.x' },
  }).trim();
}

beforeAll(() => {
  caseDir = mkdtempSync(resolve(tmpdir(), 'local-deps-test-'));
  const repoDir = resolve(caseDir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(resolve(repoDir, 'src'), { recursive: true });

  // Two-commit history so we have distinct base + head SHAs reachable.
  git(repoDir, 'init -q');
  git(repoDir, 'config commit.gpgsign false');
  writeFileSync(
    resolve(repoDir, 'src/foo.ts'),
    `export function existing() {\n  return 1;\n}\n`,
  );
  writeFileSync(resolve(repoDir, '.code-review.yml'), `severity:\n  floor: minor\n`);
  writeFileSync(resolve(repoDir, 'CLAUDE.md'), `# Repo conventions\nUse explicit return types.\n`);
  git(repoDir, 'add -A');
  git(repoDir, 'commit -q -m base');
  baseSha = git(repoDir, 'rev-parse HEAD');

  writeFileSync(
    resolve(repoDir, 'src/foo.ts'),
    `export function existing() {\n  return 1;\n}\n\nexport const NEW = 42;\n`,
  );
  git(repoDir, 'add -A');
  git(repoDir, 'commit -q -m head');
  headSha = git(repoDir, 'rev-parse HEAD');

  writeFileSync(
    resolve(caseDir, 'meta.yml'),
    [
      `case_id: synthetic-test`,
      `pr_url: https://example.com/org/repo/pull/1`,
      `owner: org`,
      `repo: repo`,
      `pull_number: 1`,
      `base_sha: ${baseSha}`,
      `head_sha: ${headSha}`,
      `captured_at: 2026-05-20T00:00:00Z`,
    ].join('\n'),
  );

  writeFileSync(
    resolve(caseDir, 'pr.json'),
    JSON.stringify({
      data: {
        title: 'Add NEW constant',
        body: 'Adds NEW',
        user: { login: 'alice' },
        base: { ref: 'main', sha: baseSha },
        head: { ref: 'feat', sha: headSha },
        labels: [{ name: 'feature' }],
        changed_files: 1,
        additions: 2,
        deletions: 0,
        draft: false,
      },
    }),
  );

  writeFileSync(
    resolve(caseDir, 'files.json'),
    JSON.stringify({
      data: [
        {
          filename: 'src/foo.ts',
          changes: 2,
          patch: '@@ -1,3 +1,5 @@\n existing\n',
        },
      ],
    }),
  );

  writeFileSync(resolve(caseDir, 'diff.patch'), DIFF);
});

afterAll(() => {
  if (caseDir) rmSync(caseDir, { recursive: true, force: true });
});

describe('buildLocalDeps', () => {
  it('loads metadata from meta.yml + pr.json', async () => {
    const { deps, meta, configSource } = await buildLocalDeps({ caseDir });
    expect(meta.case_id).toBe('synthetic-test');
    expect(meta.owner).toBe('org');
    expect(meta.pull_number).toBe(1);
    expect(deps.owner).toBe('org');
    expect(deps.pull_number).toBe(1);
    expect(deps.prContext.metadata.title).toBe('Add NEW constant');
    expect(deps.prContext.metadata.author).toBe('alice');
    expect(deps.prContext.metadata.head_sha).toBe(headSha);
    expect(deps.prContext.metadata.base_sha).toBe(baseSha);
    expect(deps.prContext.metadata.labels).toEqual(['feature']);
    expect(configSource).toBe('snapshot');
  });

  it('parses diff.patch into ChangedFile[] and merges with files.json', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    expect(deps.prContext.files).toHaveLength(1);
    const f = deps.prContext.files[0]!;
    expect(f.path).toBe('src/foo.ts');
    expect(f.is_binary).toBe(false);
    expect(f.size_bytes).toBe(2); // from files.json changes count
    expect(f.reviewable_lines.length).toBeGreaterThan(0);
  });

  it('falls back to DEFAULT_CONFIG when .code-review.yml is missing in the snapshot', async () => {
    // Use a fresh case dir without .code-review.yml committed
    const altCaseDir = mkdtempSync(resolve(tmpdir(), 'local-deps-test-alt-'));
    try {
      const repoDir = resolve(altCaseDir, 'repo');
      mkdirSync(repoDir, { recursive: true });
      git(repoDir, 'init -q');
      git(repoDir, 'config commit.gpgsign false');
      writeFileSync(resolve(repoDir, 'README.md'), 'hello');
      git(repoDir, 'add -A');
      git(repoDir, 'commit -q -m init');
      const sha = git(repoDir, 'rev-parse HEAD');

      writeFileSync(
        resolve(altCaseDir, 'meta.yml'),
        `case_id: alt\nowner: o\nrepo: r\npull_number: 1\nbase_sha: ${sha}\nhead_sha: ${sha}\n`,
      );
      writeFileSync(
        resolve(altCaseDir, 'pr.json'),
        JSON.stringify({ data: { title: 't', user: { login: 'a' }, base: { ref: 'main' }, head: { ref: 'f' } } }),
      );
      writeFileSync(resolve(altCaseDir, 'files.json'), JSON.stringify({ data: [] }));
      writeFileSync(resolve(altCaseDir, 'diff.patch'), '');

      const { configSource } = await buildLocalDeps({ caseDir: altCaseDir });
      expect(configSource).toBe('default');
    } finally {
      rmSync(altCaseDir, { recursive: true, force: true });
    }
  });

  it('LocalFileReader.read returns file content at HEAD via git show', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    const content = await deps.fileReader.read({
      owner: 'org',
      repo: 'repo',
      path: 'src/foo.ts',
      ref: headSha,
    });
    expect(content).not.toBeNull();
    expect(content).toContain('export const NEW = 42');
  });

  it('LocalFileReader.read returns the base-ref content for base SHA', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    const content = await deps.fileReader.read({
      owner: 'org',
      repo: 'repo',
      path: 'src/foo.ts',
      ref: baseSha,
    });
    expect(content).not.toBeNull();
    expect(content).not.toContain('NEW');
    expect(content).toContain('existing');
  });

  it('LocalFileReader.read returns null for a missing path', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    const content = await deps.fileReader.read({
      owner: 'org',
      repo: 'repo',
      path: 'does/not/exist.ts',
      ref: headSha,
    });
    expect(content).toBeNull();
  });

  it('LocalFileReader.readRange slices and reports totals', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    const r = await deps.fileReader.readRange(
      { owner: 'org', repo: 'repo', path: 'src/foo.ts', ref: headSha },
      1,
      2,
    );
    expect(r).not.toBeNull();
    expect(r!.returned_range).toEqual([1, 2]);
    expect(r!.content.split('\n')).toHaveLength(2);
    expect(r!.total_lines).toBeGreaterThanOrEqual(4);
  });

  it('workspaceDir points at the snapshot repo (real .git for grep)', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    expect(deps.workspaceDir).toBe(resolve(caseDir, 'repo'));
    // Sanity: `git grep` works in this dir
    const out = execSync('git grep -n NEW', { cwd: deps.workspaceDir, encoding: 'utf-8' });
    expect(out).toContain('src/foo.ts');
  });
});

describe('loadContextFilesForCase', () => {
  it('returns only the context files that exist at HEAD', async () => {
    const { deps } = await buildLocalDeps({ caseDir });
    const entries = await loadContextFilesForCase(deps, ['CLAUDE.md', 'AGENTS.md', 'README.md']);
    const names = entries.map((e) => e.file);
    expect(names).toContain('CLAUDE.md');
    expect(names).not.toContain('AGENTS.md');
    expect(names).not.toContain('README.md');
    const claude = entries.find((e) => e.file === 'CLAUDE.md')!;
    expect(claude.content).toContain('explicit return types');
  });
});
