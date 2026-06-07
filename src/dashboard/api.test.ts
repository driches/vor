import { describe, expect, it, vi } from 'vitest';
import type { LocalRunRecord } from '../local/types.js';
import { NothingToReviewError } from '../local/review.js';
import { handleApi, type DashboardDeps } from './api.js';

function record(id: string): LocalRunRecord {
  return {
    id,
    timestamp: '2026-06-07T00:00:00.000Z',
    target: 'range',
    base: { ref: 'origin/main', sha: 'a'.repeat(40) },
    head: { ref: 'HEAD', sha: 'b'.repeat(40) },
    workspace: '/ws',
    project_slug: 'ws-1234abcd',
    config_path: '.vor.yml',
    files: 2,
    additions: 5,
    deletions: 1,
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

function deps(overrides: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    runLocalReview: vi.fn(async () => record('new')),
    saveRun: vi.fn(() => '/p'),
    listRuns: vi.fn(() => [record('r1')]),
    getRun: vi.fn((_ws: string, id: string) => (id === 'r1' ? record('r1') : null)),
    workspace: '/ws',
    ...overrides,
  };
}

describe('dashboard API', () => {
  it('lists runs', async () => {
    const res = await handleApi('GET', '/api/runs', undefined, deps());
    expect(res.status).toBe(200);
    expect((res.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('gets a run and 404s on a missing one', async () => {
    expect((await handleApi('GET', '/api/runs/r1', undefined, deps())).status).toBe(200);
    expect((await handleApi('GET', '/api/runs/nope', undefined, deps())).status).toBe(404);
  });

  it('runs a review on POST and persists it', async () => {
    const d = deps();
    const res = await handleApi('POST', '/api/review', { target: 'auto' }, d);
    expect(res.status).toBe(200);
    expect(d.runLocalReview).toHaveBeenCalledOnce();
    expect(d.saveRun).toHaveBeenCalledOnce();
  });

  it('rejects an invalid review body', async () => {
    const res = await handleApi('POST', '/api/review', { target: 'bogus' }, deps());
    expect(res.status).toBe(400);
  });

  it('maps NothingToReviewError to 422', async () => {
    const d = deps({
      runLocalReview: vi.fn(async () => {
        throw new NothingToReviewError('clean');
      }),
    });
    const res = await handleApi('POST', '/api/review', {}, d);
    expect(res.status).toBe(422);
  });

  it('404s unknown routes', async () => {
    expect((await handleApi('GET', '/api/whatever', undefined, deps())).status).toBe(404);
  });
});
