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
import { logger } from '../util/logger.js';
import {
  addDetachedWorktree,
  authorFromHead,
  bodyFromHead,
  changedFiles,
  currentHeadSha,
  fileBytesAtRef,
  fileBytesOnDisk,
  hasWorkingTreeChanges,
  removeWorktree,
  repoRoot,
  resolveRef,
  titleFromHead,
  unifiedDiff,
  workingTreeChanges,
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

/**
 * Thrown when the orchestrator skipped the run because the resolved provider's
 * API key is missing. `requireApiKey` only checks that *some* key exists, but
 * config/`--model` can select a provider whose key is absent — and the
 * dashboard/MCP paths don't gate on a key at all. Without this, a skipped run
 * would persist and render as a clean "No findings" review.
 */
export class ReviewSkippedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewSkippedError';
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
  // Resolve to the repo root: git reports diff paths relative to the top-level,
  // so a review launched from a subdirectory must operate from the root or
  // file lookups and scanner roots land in the wrong place.
  const workspace = repoRoot(opts.workspace ?? process.cwd());
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
    diffArgs = ['HEAD']; // unused for working-tree; files/diff come from workingTreeChanges
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
    // Three-dot: diff from the merge-base to head, matching GitHub PR
    // semantics. Two-dot would compare tips directly and fold base-side
    // advances (commits added to base after the branch split) into the review
    // as spurious removals/edits to files the branch never touched.
    diffArgs = [`${baseSha}...${headSha}`];
    baseLabel = baseRef;
    headLabel = headRef;
    headShaForRecord = headSha;
  }

  // Working-tree mode includes untracked new files (respecting .gitignore);
  // range mode diffs two committed refs.
  const { files, diff } =
    resolved === 'working-tree'
      ? workingTreeChanges(workspace)
      : { files: changedFiles(workspace, diffArgs), diff: unifiedDiff(workspace, diffArgs) };

  if (files.length === 0) {
    throw new NothingToReviewError(
      resolved === 'working-tree'
        ? 'No uncommitted changes (tracked or untracked) to review.'
        : `No changed files between ${baseLabel} and ${headLabel}.`,
    );
  }

  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  const resolveBytes = (path: string, ref: string): Buffer | null => {
    // Explicit overrides win (A/B a synthetic .vor.yml without git churn).
    const override = overrides.get(path);
    if (override !== undefined) return Buffer.from(override, 'utf-8');
    // The working-tree head is on disk; every committed ref goes through git.
    // Raw bytes so images survive for the OCR scanner / describe_image tool.
    if (ref === WORKTREE) return fileBytesOnDisk(workspace, path);
    return fileBytesAtRef(workspace, ref, path);
  };

  // Range reviews describe the requested head, which may not be the checkout;
  // read the title/body/author from that commit so get_pr_metadata (the agent's
  // first tool call) forms intent from the branch under review. Working-tree
  // mode reviews HEAD itself, so the default ref is correct there.
  const metaRef = resolved === 'range' ? headSha : 'HEAD';
  const octokit = buildLocalOctokit({
    baseSha,
    headSha,
    files,
    diff,
    prMeta: {
      title: titleFromHead(workspace, metaRef),
      body: bodyFromHead(workspace, metaRef),
      author: authorFromHead(workspace, metaRef),
      additions,
      deletions,
    },
    resolveBytes,
  });

  // Disk-backed scanners (eslint/tsc) and grep/blast-radius run against
  // `workspace_dir`. In range mode where the requested head isn't what's checked
  // out, materialize that head in a throwaway worktree so their findings match
  // the diff instead of the current branch. The agent diff/content already come
  // from the object DB via the FakeOctokit, so they're unaffected.
  let orchestratorWorkspace = workspace;
  let cleanupWorktree: (() => void) | undefined;
  if (resolved === 'range') {
    const current = currentHeadSha(workspace);
    // Materialize a clean head tree when the checkout is at a different commit,
    // OR when it's at the right commit but has uncommitted edits — otherwise the
    // disk-backed scanners would read working-copy changes that aren't part of
    // the committed range.
    const shaDiffers = Boolean(current) && current !== headSha;
    const dirty = hasWorkingTreeChanges(workspace);
    if (shaDiffers || dirty) {
      const tree = addDetachedWorktree(workspace, headSha);
      orchestratorWorkspace = tree;
      cleanupWorktree = () => removeWorktree(workspace, tree);
      const reason = shaDiffers
        ? `differs from the checkout (${current.slice(0, 7)})`
        : 'matches a checkout with uncommitted changes';
      await logger.info(
        `Requested head ${headSha.slice(0, 7)} ${reason}; ` +
          `running disk-backed scanners against a temporary worktree.`,
      );
    }
  }

  let result;
  try {
    result = await runner({
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
      workspace_dir: orchestratorWorkspace,
      octokitFactory: () => octokit,
    });
  } finally {
    cleanupWorktree?.();
  }

  // The orchestrator resolves the provider from config/model, then skips with
  // `skipped_no_key_<provider>` when that provider's key is absent rather than
  // throwing. Surface it as an error so a skipped run is never saved or shown
  // as a clean review.
  if (result.ended.startsWith('skipped_no_key_')) {
    const provider = result.ended.slice('skipped_no_key_'.length);
    const envVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new ReviewSkippedError(
      `Review skipped: the resolved provider (${provider}) has no API key. Set ${envVar} and retry.`,
    );
  }

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
