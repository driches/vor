import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../local/git.js';
import type { LocalRunRecord } from '../local/types.js';
import { createHandlers, type VorToolDeps } from './tools.js';

function record(id: string): LocalRunRecord {
  return {
    id,
    timestamp: '2026-06-07T00:00:00.000Z',
    target: 'working-tree',
    base: { ref: 'HEAD', sha: 'a'.repeat(40) },
    head: { ref: 'working-tree', sha: null },
    workspace: '/ws',
    project_slug: 'ws-1234abcd',
    config_path: '.vor.yml',
    files: 1,
    additions: 3,
    deletions: 0,
    result: {
      comment_count: 1,
      ended: 'summary_posted',
      turns: 2,
      cost_usd: 0.05,
      dry_run: true,
      kept_comments: [
        {
          severity: 'important',
          file_path: 'src/a.ts',
          line: 10,
          side: 'RIGHT',
          category: 'bug',
          title: 'Off-by-one',
          why_it_matters: 'Loop overruns the array.',
          suggestion: 'i < n',
          confidence: 'high',
        },
      ],
    },
  };
}

function deps(overrides: Partial<VorToolDeps> = {}): VorToolDeps {
  return {
    runLocalReview: vi.fn(async () => record('new-run')),
    saveRun: vi.fn(() => '/path/new-run.json'),
    listRuns: vi.fn(() => [record('r1'), record('r2')]),
    getRun: vi.fn((_ws: string, id: string) => (id === 'r1' ? record('r1') : null)),
    workspace: '/ws',
    ...overrides,
  };
}

function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('MCP tool handlers', () => {
  it('review_local_changes runs, saves, and returns a compact summary', async () => {
    const d = deps();
    const h = createHandlers(d);
    const res = await h.review_local_changes({ target: 'working-tree' });
    expect(d.runLocalReview).toHaveBeenCalledOnce();
    expect(d.saveRun).toHaveBeenCalledOnce();
    const body = parse(res) as { findings: { title: string }[]; cost_usd: number };
    expect(body.findings[0]!.title).toBe('Off-by-one');
    expect(body.cost_usd).toBe(0.05);
  });

  it('review_local_changes honors save:false', async () => {
    const d = deps();
    const h = createHandlers(d);
    await h.review_local_changes({ save: false });
    expect(d.saveRun).not.toHaveBeenCalled();
  });

  it('review_local_changes reports failures as an error result', async () => {
    const d = deps({
      runLocalReview: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const res = await createHandlers(d).review_local_changes({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('boom');
  });

  it('list_runs returns summaries', async () => {
    const res = await createHandlers(deps()).list_runs({});
    const body = parse(res) as unknown[];
    expect(body).toHaveLength(2);
  });

  it('get_run returns a found run and errors on a missing one', async () => {
    const h = createHandlers(deps());
    expect((parse(await h.get_run({ id: 'r1' })) as { id: string }).id).toBe('r1');
    const missing = await h.get_run({ id: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('keys history off the repo root when started in a subdirectory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vor-mcp-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'pkg', 'nested'), { recursive: true });
    try {
      const d = deps({ workspace: join(repo, 'pkg', 'nested') });
      await createHandlers(d).list_runs({});
      // Resolved to the repo root, not the nested subdirectory.
      expect(d.listRuns).toHaveBeenCalledWith(repoRoot(repo), expect.anything());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
