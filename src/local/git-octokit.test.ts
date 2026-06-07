import { describe, expect, it } from 'vitest';
import { buildLocalOctokit, splitPatchesByFile } from './git-octokit.js';
import type { ChangedFile } from './git.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 2;',
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1 @@',
  '+export const b = 3;',
  '',
].join('\n');

const FILES: ChangedFile[] = [
  { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
  { path: 'new.ts', status: 'added', additions: 1, deletions: 0 },
];

describe('splitPatchesByFile', () => {
  it('keys per-file patches by the new path', () => {
    const map = splitPatchesByFile(DIFF);
    expect([...map.keys()].sort()).toEqual(['new.ts', 'src/a.ts']);
    expect(map.get('src/a.ts')).toContain('+export const a = 2;');
    expect(map.get('new.ts')).toContain('+export const b = 3;');
  });

  it('returns an empty map for an empty diff', () => {
    expect(splitPatchesByFile('').size).toBe(0);
  });
});

describe('buildLocalOctokit listFiles', () => {
  it('populates a non-null patch for each text file (so they are not gated binary)', async () => {
    const octokit = buildLocalOctokit({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      files: FILES,
      diff: DIFF,
      prMeta: { title: 't', body: '', author: 'me', additions: 2, deletions: 1 },
      resolveContent: () => null,
    });
    const res = await octokit.rest.pulls.listFiles({
      owner: 'local',
      repo: 'local',
      pull_number: 0,
    });
    const byName = Object.fromEntries(
      (res.data as { filename: string; patch: string | null }[]).map((f) => [f.filename, f.patch]),
    );
    expect(byName['src/a.ts']).toBeTruthy();
    expect(byName['src/a.ts']).toContain('export const a = 2;');
    expect(byName['new.ts']).toBeTruthy();
    // Never null — that is the binary signal fetchPRContext keys on.
    for (const patch of Object.values(byName)) expect(patch).not.toBeNull();
  });

  it('paginates listFiles so the fetch loop terminates on large diffs', async () => {
    const many: ChangedFile[] = Array.from({ length: 150 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'added' as const,
      additions: 1,
      deletions: 0,
    }));
    const octokit = buildLocalOctokit({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      files: many,
      diff: '',
      prMeta: { title: 't', body: '', author: 'me', additions: 150, deletions: 0 },
      resolveContent: () => null,
    });
    const lf = octokit.rest.pulls.listFiles;
    const page1 = (await lf({ owner: 'l', repo: 'l', pull_number: 0, per_page: 100, page: 1 }))
      .data;
    const page2 = (await lf({ owner: 'l', repo: 'l', pull_number: 0, per_page: 100, page: 2 }))
      .data;
    const page3 = (await lf({ owner: 'l', repo: 'l', pull_number: 0, per_page: 100, page: 3 }))
      .data;
    expect(page1).toHaveLength(100);
    expect(page2).toHaveLength(50); // < per_page → fetch loop breaks here
    expect(page3).toHaveLength(0);
  });
});
