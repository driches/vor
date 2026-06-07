import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './git.js';
import { getRun, listRuns, projectSlug, saveRun } from './store.js';
import type { LocalRunRecord } from './types.js';

function record(workspace: string, id: string): LocalRunRecord {
  return {
    id,
    timestamp: new Date().toISOString(),
    target: 'working-tree',
    base: { ref: 'HEAD', sha: 'a'.repeat(40) },
    head: { ref: 'working-tree', sha: null },
    workspace,
    project_slug: projectSlug(workspace),
    config_path: '.vor.yml',
    files: 1,
    additions: 1,
    deletions: 0,
    result: {
      comment_count: 0,
      ended: 'summary_posted',
      turns: 1,
      cost_usd: 0,
      dry_run: true,
      kept_comments: [],
    },
  };
}

describe('run history keyed by repo root', () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vor-home-'));
    process.env.VOR_HOME = home;
    repo = mkdtempSync(join(tmpdir(), 'vor-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'pkg', 'nested'), { recursive: true });
  });

  afterEach(() => {
    delete process.env.VOR_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('finds a root-saved run when reading from a subdirectory (via repoRoot)', () => {
    // A review run normalizes its workspace to the repo root before saving.
    const rootWs = repoRoot(repo);
    saveRun(record(rootWs, 'run-1'));

    // History commands launched from a nested dir resolve the same root, so the
    // run is listable/showable rather than disappearing under a subdir slug.
    const readWs = repoRoot(join(repo, 'pkg', 'nested'));
    expect(readWs).toBe(rootWs);
    expect(listRuns(readWs).map((r) => r.id)).toContain('run-1');
    expect(getRun(readWs, 'run-1')).not.toBeNull();
  });
});
