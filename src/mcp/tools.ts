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
import type { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { resolveWorkspaceArchitectureConfig } from '../architecture/loader.js';
import { resolveArchitectureSpec } from '../architecture/presets.js';
import { runRepoArchitectureCheck } from '../architecture/repo-scan.js';
import { loadConfigFromString } from '../config/loader.js';
import { architecturePresetSchema } from '../config/schema.js';
import type { ReferencesConfig } from '../config/types.js';
import { createOctokit } from '../github/client.js';
import { loadReferences, type LoadedReferenceCorpus } from '../references/loader.js';
import {
  listReferenceCatalog,
  readReferenceSlice,
  searchReferenceCorpus,
} from '../references/search.js';
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
  /** Optional GitHub client for `github:` reference loading. Defaults to GITHUB_TOKEN if set. */
  octokit?: Octokit;
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
export const checkArchitectureInput = {
  config_path: z.string().optional(),
  arch_config_path: z.string().optional(),
  preset: architecturePresetSchema.optional(),
  root: z.string().optional(),
  fail_on: z.enum(['critical', 'important', 'minor', 'nit']).optional(),
};
export const listReferencesInput = {
  config_path: z.string().optional(),
  refresh: z.boolean().optional(),
};
export const readReferenceInput = {
  config_path: z.string().optional(),
  id: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
};

type ReviewArgs = z.infer<z.ZodObject<typeof reviewInput>>;
type ListRunsArgs = z.infer<z.ZodObject<typeof listRunsInput>>;
type GetRunArgs = z.infer<z.ZodObject<typeof getRunInput>>;
type GetConfigArgs = z.infer<z.ZodObject<typeof getConfigInput>>;
type CheckArchitectureArgs = z.infer<z.ZodObject<typeof checkArchitectureInput>>;
type ListReferencesArgs = z.infer<z.ZodObject<typeof listReferencesInput>>;
type ReadReferenceArgs = z.infer<z.ZodObject<typeof readReferenceInput>>;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const REFERENCE_CORPUS_MEMO_TTL_MS = 10_000;

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

  const readWorkspaceConfig = (configPath?: string) => {
    // config_path is client-supplied; confine it to the workspace so `../`
    // can't coax tools into reading (and returning) a file outside the
    // repo. An escaping path falls back to defaults, as a missing file would.
    const root = resolve(workspace);
    const path = resolve(root, configPath ?? '.vor.yml');
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
    return loadConfigFromString(raw);
  };

  const resolveOctokit = (): Octokit | undefined => {
    if (deps.octokit) return deps.octokit;
    const token = process.env.GITHUB_TOKEN?.trim();
    return token ? createOctokit({ auth: token }) : undefined;
  };

  let cachedCorpus: { key: string; loadedAt: number; corpus: LoadedReferenceCorpus } | null = null;
  const getReferenceCorpus = async (
    config: ReferencesConfig,
    forceRefresh = false,
  ): Promise<LoadedReferenceCorpus> => {
    const key = `${workspace}\0${JSON.stringify(config)}`;
    const now = Date.now();
    if (
      !forceRefresh &&
      cachedCorpus &&
      cachedCorpus.key === key &&
      now - cachedCorpus.loadedAt < REFERENCE_CORPUS_MEMO_TTL_MS
    ) {
      return cachedCorpus.corpus;
    }
    const octokit = resolveOctokit();
    const corpus = await loadReferences({
      config,
      workspaceDir: workspace,
      ...(octokit ? { octokit } : {}),
      forceRefresh,
    });
    cachedCorpus = { key, loadedAt: now, corpus };
    return corpus;
  };

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
      return ok(readWorkspaceConfig(args.config_path));
    },

    check_architecture: async (args: CheckArchitectureArgs): Promise<ToolResult> => {
      try {
        const resolved = resolveWorkspaceArchitectureConfig({
          workspaceDir: workspace,
          ...(args.config_path !== undefined ? { configPath: args.config_path } : {}),
          ...(args.arch_config_path !== undefined ? { archConfigPath: args.arch_config_path } : {}),
          ...(args.preset !== undefined ? { preset: args.preset } : {}),
          ...(args.root !== undefined ? { root: args.root } : {}),
          strict: true,
        });

        if (!resolved.architecture.enabled) {
          return fail(
            'No architecture configuration found. Configure `architecture` in .vor.yml, create .vor/architecture.yml, or pass a `preset`.',
          );
        }

        const spec = resolveArchitectureSpec(resolved.architecture);
        const result = await runRepoArchitectureCheck({
          workspaceDir: workspace,
          spec,
          excludePaths: resolved.reviewConfig.exclude.paths,
          ignoreFilePath: resolved.reviewConfig.security.ignore_file,
          ...(args.fail_on !== undefined ? { failOn: args.fail_on } : {}),
        });
        return ok(result);
      } catch (err) {
        return fail(`Architecture check failed: ${(err as Error).message}`);
      }
    },

    list_references: async (args: ListReferencesArgs): Promise<ToolResult> => {
      try {
        const cfg = readWorkspaceConfig(args.config_path);
        if (!cfg.references.enabled) {
          return ok({
            enabled: false,
            docs: [],
            message:
              'Reference documentation is not enabled in .vor.yml (`references.enabled: true`).',
          });
        }
        const corpus = await getReferenceCorpus(cfg.references, Boolean(args.refresh));
        return ok({
          enabled: true,
          corpus_digest: corpus.corpus_digest,
          total_inline_bytes: corpus.total_inline_bytes,
          total_bytes: corpus.total_bytes,
          cache_dir: corpus.cache_dir,
          cache_stats: corpus.cache_stats,
          warnings: corpus.warnings,
          docs: listReferenceCatalog(corpus),
        });
      } catch (err) {
        return fail(`Failed to list references: ${(err as Error).message}`);
      }
    },

    read_reference: async (args: ReadReferenceArgs): Promise<ToolResult> => {
      try {
        const cfg = readWorkspaceConfig(args.config_path);
        if (!cfg.references.enabled) {
          return fail(
            'Reference documentation is not enabled in .vor.yml (`references.enabled: true`).',
          );
        }
        const corpus = await getReferenceCorpus(cfg.references);
        if (args.id) {
          const slice = readReferenceSlice(corpus, {
            id: args.id,
            ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
            ...(args.end_line !== undefined ? { end_line: args.end_line } : {}),
          });
          if (!slice.ok) {
            return fail(`${slice.error} Available IDs: ${slice.available_ids.join(', ')}`);
          }
          return ok(slice);
        }
        if (args.query) {
          const matches = searchReferenceCorpus(corpus, args.query);
          return ok({ query: args.query, match_count: matches.length, matches });
        }
        return ok({ total_docs: corpus.docs.length, docs: listReferenceCatalog(corpus) });
      } catch (err) {
        return fail(`Failed to read reference: ${(err as Error).message}`);
      }
    },
  };
}

export type VorHandlers = ReturnType<typeof createHandlers>;
