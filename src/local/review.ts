/**
 * runLocalReview — runs the full production orchestrator (scanners + agent)
 * against a local git working copy with no GitHub round-trip, and returns a
 * persistable run record. Shared by the CLI, dashboard, and MCP server.
 *
 * Target resolution:
 *   - 'working-tree': diff HEAD against uncommitted changes; head content is
 *     read from disk so the agent sees what you'd commit next.
 *   - 'range':        diff <base>..<head> between two committed refs.
 *   - 'auto':         working-tree when the tree is dirty, else range.
 */

import { runOrchestrator } from '../orchestrator.js';
import {
  authorFromHead,
  bodyFromHead,
  changedFiles,
  fileContentAtRef,
  fileContentOnDisk,
  hasWorkingTreeChanges,
  resolveRef,
  titleFromHead,
  unifiedDiff,
} from './git.js';
import { buildLocalOctokit } from './git-octokit.js';
import { newRunId, projectSlug } from './store.js';
import type { LocalReviewOptions, LocalRunRecord, ResolvedTarget } from './types.js';

/** Sentinel head ref meaning "read content from the working tree on disk". */
const WORKTREE = 'WORKTREE';

/** Thrown when there is nothing to review (clean tree, or identical refs). */
export class NothingToReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NothingToReviewError';
  }
}

export interface RunLocalReviewDeps {
  /** Override for tests so no real LLM/orchestrator call happens. */
  runOrchestratorImpl?: typeof runOrchestrator;
  /**
   * Path → synthetic content overrides for `repos.getContent` (e.g. inject a
   * different `.vor.yml` to A/B a flag). Preserves the behavior of
   * scripts/local-review.ts's `--scanner-findings-in-user-prompt`.
   */
  contentOverrides?: Map<string, string>;
}

export async function runLocalReview(
  opts: LocalReviewOptions = {},
  deps: RunLocalReviewDeps = {},
): Promise<LocalRunRecord> {
  const workspace = opts.workspace ?? process.cwd();
  const configPath = opts.configPath ?? '.vor.yml';
  const runner = deps.runOrchestratorImpl ?? runOrchestrator;
  const overrides = deps.contentOverrides ?? new Map<string, string>();

  const resolved: ResolvedTarget =
    opts.target === 'working-tree'
      ? 'working-tree'
      : opts.target === 'range'
        ? 'range'
        : hasWorkingTreeChanges(workspace)
          ? 'working-tree'
          : 'range';

  // Range spec + content resolver differ per target. Everything downstream is
  // shared, so compute these two and the head SHA once.
  let diffArgs: string[];
  let baseSha: string;
  let headSha: string;
  let baseLabel: string;
  let headLabel: string;
  let headShaForRecord: string | null;

  if (resolved === 'working-tree') {
    baseSha = resolveRef(workspace, 'HEAD');
    headSha = WORKTREE;
    diffArgs = ['HEAD'];
    baseLabel = 'HEAD';
    headLabel = 'working-tree';
    headShaForRecord = null;
  } else {
    const baseRef = opts.base ?? 'origin/main';
    const headRef = opts.head ?? 'HEAD';
    baseSha = resolveRef(workspace, baseRef);
    headSha = resolveRef(workspace, headRef);
    if (baseSha === headSha) {
      throw new NothingToReviewError(
        `Base and head resolve to the same commit (${baseSha.slice(0, 7)}). Nothing to review.`,
      );
    }
    diffArgs = [`${baseSha}..${headSha}`];
    baseLabel = baseRef;
    headLabel = headRef;
    headShaForRecord = headSha;
  }

  const files = changedFiles(workspace, diffArgs);
  if (files.length === 0) {
    throw new NothingToReviewError(
      resolved === 'working-tree'
        ? 'No uncommitted changes to tracked files. Nothing to review.'
        : `No changed files between ${baseLabel} and ${headLabel}.`,
    );
  }

  const diff = unifiedDiff(workspace, diffArgs);
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  const resolveContent = (path: string, ref: string): string | null => {
    // Explicit overrides win (A/B a synthetic .vor.yml without git churn).
    const override = overrides.get(path);
    if (override !== undefined) return override;
    // The working-tree head is on disk; every committed ref goes through git.
    if (ref === WORKTREE) return fileContentOnDisk(workspace, path);
    return fileContentAtRef(workspace, ref, path);
  };

  const octokit = buildLocalOctokit({
    baseSha,
    headSha,
    files,
    diff,
    prMeta: {
      title: titleFromHead(workspace),
      body: bodyFromHead(workspace),
      author: authorFromHead(workspace),
      additions,
      deletions,
    },
    resolveContent,
  });

  const result = await runner({
    owner: 'local',
    repo: 'local',
    pull_number: 0,
    anthropic_api_key: opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY?.trim() ?? '',
    openai_api_key: opts.openaiApiKey ?? process.env.OPENAI_API_KEY?.trim() ?? '',
    // Unused by the FakeOctokit, but the orchestrator passes it to
    // logger.setSecret(); a non-empty placeholder keeps that contract happy.
    github_token: 'local-review-placeholder-token',
    ...(opts.model !== undefined ? { model_override: opts.model } : {}),
    config_path: configPath,
    dry_run: true,
    workspace_dir: workspace,
    octokitFactory: () => octokit,
  });

  return {
    id: newRunId(),
    timestamp: new Date().toISOString(),
    target: resolved,
    base: { ref: baseLabel, sha: baseSha },
    head: { ref: headLabel, sha: headShaForRecord },
    workspace,
    project_slug: projectSlug(workspace),
    config_path: configPath,
    files: files.length,
    additions,
    deletions,
    result,
  };
}
