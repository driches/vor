import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRun, latestRun, listRuns, newRunId, projectSlug, saveRun, vorHome } from './store.js';
import type { LocalRunRecord } from './types.js';

function makeRecord(workspace: string, id: string): LocalRunRecord {
  return {
    id,
    timestamp: new Date().toISOString(),
    target: 'range',
    base: { ref: 'origin/main', sha: 'a'.repeat(40) },
    head: { ref: 'HEAD', sha: 'b'.repeat(40) },
    workspace,
    project_slug: projectSlug(workspace),
    config_path: '.vor.yml',
    files: 2,
    additions: 10,
    deletions: 3,
    result: {
      comment_count: 1,
      ended: 'summary_posted',
      turns: 4,
      cost_usd: 0.12,
      dry_run: true,
      kept_comments: [],
    },
  };
}

describe('local run store', () => {
  let home: string;
  const workspace = '/some/project/path';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vor-home-'));
    process.env.VOR_HOME = home;
  });

  afterEach(() => {
    delete process.env.VOR_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('honors VOR_HOME', () => {
    expect(vorHome()).toBe(home);
  });

  it('round-trips a saved run', () => {
    const rec = makeRecord(workspace, newRunId());
    saveRun(rec);
    const got = getRun(workspace, rec.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(rec.id);
    expect(got!.result.cost_usd).toBe(0.12);
  });

  it('lists runs newest first and honors limit', async () => {
    const ids = [
      '2026-01-01T00-00-00-000Z-aaa',
      '2026-02-01T00-00-00-000Z-bbb',
      '2026-03-01T00-00-00-000Z-ccc',
    ];
    for (const id of ids) saveRun(makeRecord(workspace, id));
    const all = listRuns(workspace);
    expect(all.map((r) => r.id)).toEqual([...ids].reverse());
    expect(listRuns(workspace, { limit: 2 })).toHaveLength(2);
    expect(latestRun(workspace)!.id).toBe(ids[2]);
  });

  it('returns null for a missing run and empty list for an unknown workspace', () => {
    expect(getRun(workspace, 'nope')).toBeNull();
    expect(listRuns('/never/seen')).toEqual([]);
    expect(latestRun('/never/seen')).toBeNull();
  });

  it('rejects run ids that try to traverse out of the project directory', () => {
    // Plant a record in a sibling project; a traversal id must not reach it.
    const other = '/some/other/project';
    const planted = makeRecord(other, newRunId());
    saveRun(planted);
    const escape = join('..', projectSlug(other), planted.id);
    expect(getRun(workspace, escape)).toBeNull();
    expect(getRun(workspace, '../../etc/passwd')).toBeNull();
  });

  it('keeps different checkouts of the same basename separate', () => {
    expect(projectSlug('/a/vor')).not.toBe(projectSlug('/b/vor'));
    expect(projectSlug('/a/vor')).toMatch(/^vor-[0-9a-f]{8}$/);
  });

  it('generates unique sortable ids', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
  });
});
