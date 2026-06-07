/**
 * Dashboard JSON API — pure request routing, independent of node:http so it can
 * be unit-tested directly. `handleApi` takes a method + path + parsed body and
 * returns a status/payload; server.ts adapts it to req/res.
 *
 * Routes:
 *   GET  /api/runs          → recent run summaries
 *   GET  /api/runs/:id      → one run summary
 *   POST /api/review        → run a review, persist it, return the summary
 *   GET  /api/config        → resolved .vor.yml
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfigFromString } from '../config/loader.js';
import {
  NothingToReviewError,
  ReviewSkippedError,
  runLocalReview as defaultRunLocalReview,
} from '../local/review.js';
import {
  getRun as defaultGetRun,
  listRuns as defaultListRuns,
  saveRun as defaultSaveRun,
} from '../local/store.js';
import { summarizeRun } from '../local/summary.js';

export interface DashboardDeps {
  runLocalReview: typeof defaultRunLocalReview;
  saveRun: typeof defaultSaveRun;
  listRuns: typeof defaultListRuns;
  getRun: typeof defaultGetRun;
  workspace: string;
}

export function defaultDashboardDeps(workspace: string): DashboardDeps {
  return {
    runLocalReview: defaultRunLocalReview,
    saveRun: defaultSaveRun,
    listRuns: defaultListRuns,
    getRun: defaultGetRun,
    workspace,
  };
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const reviewBody = z.object({
  target: z.enum(['auto', 'working-tree', 'range']).optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  model: z.string().optional(),
});

function notFound(): ApiResponse {
  return { status: 404, body: { error: 'not_found' } };
}

export async function handleApi(
  method: string,
  pathname: string,
  body: unknown,
  deps: DashboardDeps,
): Promise<ApiResponse> {
  if (method === 'GET' && pathname === '/api/runs') {
    const runs = deps.listRuns(deps.workspace, { limit: 50 }).map(summarizeRun);
    return { status: 200, body: { runs } };
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch) {
    const record = deps.getRun(deps.workspace, decodeURIComponent(runMatch[1]!));
    if (!record) return notFound();
    return { status: 200, body: summarizeRun(record) };
  }

  if (method === 'GET' && pathname === '/api/config') {
    let raw: string | null = null;
    try {
      raw = readFileSync(join(deps.workspace, '.vor.yml'), 'utf-8');
    } catch {
      raw = null;
    }
    return { status: 200, body: loadConfigFromString(raw) };
  }

  if (method === 'POST' && pathname === '/api/review') {
    const parsed = reviewBody.safeParse(body ?? {});
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_request', detail: parsed.error.issues } };
    }
    try {
      const record = await deps.runLocalReview({
        workspace: deps.workspace,
        target: parsed.data.target ?? 'auto',
        ...(parsed.data.base !== undefined ? { base: parsed.data.base } : {}),
        ...(parsed.data.head !== undefined ? { head: parsed.data.head } : {}),
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      });
      deps.saveRun(record);
      return { status: 200, body: summarizeRun(record) };
    } catch (err) {
      if (err instanceof NothingToReviewError) {
        return { status: 422, body: { error: 'nothing_to_review', message: err.message } };
      }
      if (err instanceof ReviewSkippedError) {
        return { status: 400, body: { error: 'no_api_key', message: err.message } };
      }
      return { status: 500, body: { error: 'review_failed', message: (err as Error).message } };
    }
  }

  return notFound();
}
