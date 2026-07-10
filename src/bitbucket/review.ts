import type { ProviderId } from '../llm/types.js';
import { createBitbucketPlatform } from './platform.js';
import { runReviewWithPlatform, type OrchestratorOutput } from '../platform/runner.js';

export interface BitbucketReviewOptions {
  workspace?: string;
  repo?: string;
  pr?: number;
  configPath?: string;
  model?: string;
  provider?: ProviderId;
  dryRun?: boolean;
  apiBaseUrl?: string;
  workspaceDir?: string;
  email?: string;
  apiToken?: string;
}

export async function runBitbucketReview(
  opts: BitbucketReviewOptions = {},
): Promise<OrchestratorOutput> {
  const workspace = (opts.workspace ?? process.env.BITBUCKET_WORKSPACE ?? '').trim();
  const repo = (opts.repo ?? process.env.BITBUCKET_REPO_SLUG ?? '').trim();
  const pr =
    opts.pr ??
    parseIntOrUndefined(process.env.BITBUCKET_PR_ID) ??
    parseIntOrUndefined(process.env.INPUT_PR_NUMBER);
  const email = (opts.email ?? process.env.BITBUCKET_API_EMAIL ?? '').trim();
  const apiToken = (opts.apiToken ?? process.env.BITBUCKET_API_TOKEN ?? '').trim();

  if (!workspace || !repo || pr === undefined || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(
      `Missing Bitbucket workspace/repo/pr (workspace='${workspace}', repo='${repo}', pr=${pr ?? 0}). ` +
        'Run from a pull-request Pipeline or pass --workspace, --repo, and --pr.',
    );
  }
  if (!email || !apiToken) {
    throw new Error('BITBUCKET_API_EMAIL and BITBUCKET_API_TOKEN are required.');
  }

  const platform = createBitbucketPlatform({
    workspace,
    repoSlug: repo,
    pullRequestId: pr,
    email,
    apiToken,
    ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
  });

  return runReviewWithPlatform({
    platform,
    anthropic_api_key: process.env.ANTHROPIC_API_KEY?.trim() ?? '',
    openai_api_key: process.env.OPENAI_API_KEY?.trim() ?? '',
    ...(opts.model !== undefined ? { model_override: opts.model } : {}),
    ...(opts.provider !== undefined ? { provider_override: opts.provider } : {}),
    config_path: opts.configPath ?? '.vor.yml',
    dry_run: opts.dryRun ?? false,
    workspace_dir: opts.workspaceDir ?? process.env.BITBUCKET_CLONE_DIR?.trim() ?? process.cwd(),
  });
}

function parseIntOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const normalized = v.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isSafeInteger(n) ? n : undefined;
}
