/**
 * VOR's MCP tool surface — what other agents (e.g. Claude Code) can call.
 *
 * Handlers are plain async functions so they can be unit-tested directly, then
 * registered on an McpServer by `registerVorTools`. Every handler validates its
 * input via the Zod shape the SDK enforces before it runs, consistent with
 * VOR's "tools validate before they take effect" invariant. Inputs are also
 * defensively re-read from the workspace, never trusted blindly.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfigFromString } from '../config/loader.js';
import { repoRoot } from '../local/git.js';
import { runLocalReview as defaultRunLocalReview } from '../local/review.js';
import {
  getRun as defaultGetRun,
  listRuns as defaultListRuns,
  saveRun as defaultSaveRun,
} from '../local/store.js';
import { summarizeRun } from '../local/summary.js';

export interface VorToolDeps {
  runLocalReview: typeof defaultRunLocalReview;
  saveRun: typeof defaultSaveRun;
  listRuns: typeof defaultListRuns;
  getRun: typeof defaultGetRun;
  /** Working directory the tools operate on. Defaults to process.cwd(). */
  workspace?: string;
}

export function defaultDeps(): VorToolDeps {
  return {
    runLocalReview: defaultRunLocalReview,
    saveRun: defaultSaveRun,
    listRuns: defaultListRuns,
    getRun: defaultGetRun,
  };
}

// Tool input shapes (Zod raw shapes, as the MCP SDK expects).
export const reviewInput = {
  target: z.enum(['auto', 'working-tree', 'range']).optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  model: z.string().optional(),
  save: z.boolean().optional(),
};
export const listRunsInput = {
  limit: z.number().int().positive().max(200).optional(),
};
export const getRunInput = {
  id: z.string().min(1),
};
export const getConfigInput = {
  config_path: z.string().optional(),
};

type ReviewArgs = z.objectOutputType<typeof reviewInput, z.ZodTypeAny>;
type ListRunsArgs = z.objectOutputType<typeof listRunsInput, z.ZodTypeAny>;
type GetRunArgs = z.objectOutputType<typeof getRunInput, z.ZodTypeAny>;
type GetConfigArgs = z.objectOutputType<typeof getConfigInput, z.ZodTypeAny>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createHandlers(deps: VorToolDeps) {
  // Resolve to the repo root so review writes, history reads (list_runs/get_run),
  // and get_config all key off the same path — matching runLocalReview, which
  // normalizes internally. Otherwise an MCP session in a subdir would save runs
  // under the root slug but read them under the subdir slug.
  const workspace = repoRoot(deps.workspace ?? process.cwd());

  return {
    review_local_changes: async (args: ReviewArgs): Promise<ToolResult> => {
      try {
        const record = await deps.runLocalReview({
          workspace,
          target: args.target ?? 'auto',
          ...(args.base !== undefined ? { base: args.base } : {}),
          ...(args.head !== undefined ? { head: args.head } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
        });
        if (args.save !== false) deps.saveRun(record);
        return ok(summarizeRun(record));
      } catch (err) {
        return fail(`Review failed: ${(err as Error).message}`);
      }
    },

    list_runs: async (args: ListRunsArgs): Promise<ToolResult> => {
      const records = deps.listRuns(workspace, { limit: args.limit ?? 20 });
      return ok(records.map(summarizeRun));
    },

    get_run: async (args: GetRunArgs): Promise<ToolResult> => {
      const record = deps.getRun(workspace, args.id);
      if (!record) return fail(`No run found with id ${args.id}.`);
      return ok(summarizeRun(record));
    },

    get_config: async (args: GetConfigArgs): Promise<ToolResult> => {
      // config_path is client-supplied; confine it to the workspace so `../`
      // can't coax get_config into reading (and returning) a file outside the
      // repo. An escaping path falls back to defaults, as a missing file would.
      const root = resolve(workspace);
      const path = resolve(root, args.config_path ?? '.vor.yml');
      const rel = relative(root, path);
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      let raw: string | null = null;
      if (inside) {
        try {
          raw = readFileSync(path, 'utf-8');
        } catch {
          raw = null; // defaults apply
        }
      }
      return ok(loadConfigFromString(raw));
    },
  };
}

export type VorHandlers = ReturnType<typeof createHandlers>;
