/**
 * Top-level flow: fetch PR → load config + context → run agent → post review.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runAgent } from './agent/runner.js';
import { buildSystemPrompt, type RepoContextEntry } from './agent/system-prompt.js';
import { buildUserPrompt } from './agent/user-prompt.js';
import { loadConfigFromString } from './config/loader.js';
import { DEFAULT_CONFIG } from './config/defaults.js';
import type { ReviewConfig } from './config/types.js';
import { createOctokit } from './github/client.js';
import { FileReader } from './github/file-reader.js';
import { fetchPRContext } from './github/pr-context.js';
import { dismissPriorAgentReviews } from './github/prior-reviews.js';
import { postReview } from './github/review-poster.js';
import { ReviewAggregator } from './output/aggregator.js';
import { logDryRunReview } from './output/dry-run-logger.js';
import { filterComments } from './output/filter.js';
import { renderSummary } from './output/formatter.js';
import { scanFindingToPostedComment } from './scanners/adapter.js';
import { InMemoryScanCache } from './scanners/cache.js';
import { dedupScannerFindings } from './scanners/dedup.js';
import { IgnoreList } from './scanners/ignore-list.js';
import { buildEnabledScanners } from './scanners/registry.js';
import { runScanners } from './scanners/runner.js';
import type { ScannerDeps } from './scanners/types.js';
import { validateScanFinding } from './scanners/validate.js';
import { registerSecret } from './util/secrets.js';
import { logger } from './util/logger.js';

export interface OrchestratorInput {
  owner: string;
  repo: string;
  pull_number: number;
  anthropic_api_key: string;
  github_token: string;
  model_override?: string;
  max_turns_override?: number;
  config_path: string;
  dry_run: boolean;
  workspace_dir: string;
}

export interface OrchestratorOutput {
  review_id?: number;
  comment_count: number;
  ended: string;
  turns: number;
  cost_usd: number;
  dry_run: boolean;
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  registerSecret(input.anthropic_api_key);
  registerSecret(input.github_token);
  await logger.setSecret(input.anthropic_api_key);
  await logger.setSecret(input.github_token);

  await logger.info(
    `Starting code review for ${input.owner}/${input.repo}#${input.pull_number}` +
      (input.dry_run ? ' (DRY RUN)' : ''),
  );

  const octokit = createOctokit({ auth: input.github_token });

  // Fetch PR metadata + files + diff
  const prContext = await fetchPRContext(octokit, {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
  });
  await logger.info(
    `Loaded PR: "${prContext.metadata.title}" by @${prContext.metadata.author} ` +
      `(${prContext.files.length} files, +${prContext.metadata.additions}/-${prContext.metadata.deletions})`,
  );

  if (prContext.metadata.draft) {
    await logger.notice('PR is in draft state. Skipping review (set ready-for-review to trigger).');
    return {
      comment_count: 0,
      ended: 'skipped_draft',
      turns: 0,
      cost_usd: 0,
      dry_run: input.dry_run,
    };
  }

  // Load .code-review.yml from the PR HEAD
  const fileReader = new FileReader(octokit);
  const config = await loadConfig(input, fileReader, prContext.metadata.head_sha);
  if (input.model_override) config.model = input.model_override;
  if (input.max_turns_override) config.max_turns = input.max_turns_override;

  await logger.info(
    `Config: model=${config.model}, max_turns=${config.max_turns}, ` +
      `severity_floor=${config.severity.floor}, sticky=${config.review.sticky}, ` +
      `event=${config.review.event}`,
  );

  // Load repo context files
  const contextFiles = await loadRepoContextFiles(
    fileReader,
    input.owner,
    input.repo,
    prContext.metadata.head_sha,
    config.context.include,
  );

  const systemPrompt = buildSystemPrompt({
    config,
    repoName: `${input.owner}/${input.repo}`,
    contextFiles,
  });
  const userPrompt = buildUserPrompt({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
  });

  // Load the security ignore list at HEAD. Always returns a usable instance —
  // malformed YAML / missing file degrades to an empty list inside .load().
  const ignoreList = await IgnoreList.load(fileReader, {
    owner: input.owner,
    repo: input.repo,
    ref: prContext.metadata.head_sha,
    path: config.security.ignore_file,
  });

  // Build aggregator + scanner pipeline. The agent and scanners share the
  // same aggregator so the filter pipeline applies uniformly to both.
  const aggregator = new ReviewAggregator();
  const scanners = buildEnabledScanners(config.security);
  const scannerDeps: ScannerDeps = {
    octokit,
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
    head_sha: prContext.metadata.head_sha,
    changedFiles: prContext.files,
    contextFiles,
    diff: prContext.diff,
    workspaceDir: input.workspace_dir,
    cache: new InMemoryScanCache(),
    ignoreList,
    fileReader,
    config: config.security,
  };

  // Fire agent + scanners in parallel. The runner is error-isolated, so a
  // scanner failure cannot reject this Promise.all — every scanner produces a
  // ScanResult (possibly with non-fatal errors). The agent itself can throw,
  // and we let that propagate as before.
  const [result, scanRunResult] = await Promise.all([
    runAgent({
      deps: {
        octokit,
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pull_number,
        prContext,
        fileReader,
        aggregator,
        config,
        workspaceDir: input.workspace_dir,
      },
      systemPrompt,
      userPrompt,
      model: config.model,
      maxTurns: config.max_turns,
      maxInputTokens: config.budget.max_input_tokens,
      maxOutputTokens: config.budget.max_output_tokens,
      apiKey: input.anthropic_api_key,
    }),
    runScanners(scanners, scannerDeps),
  ]);

  await logger.info(
    `Agent finished: ${result.ended}, ${result.turns} turns, ` +
      `${aggregator.acceptedComments.length} comments collected, $${result.costUsd.toFixed(4)}`,
  );

  // Pass 2 dedup: drop scanner findings that overlap an AI security-adjacent
  // comment (dependency-cve findings are protected — see dedup.ts).
  //
  // Ordering matters here. We dedup against the AI comments that will ACTUALLY
  // SURVIVE the post-filter (severity floor + caps), not the raw pre-cap list.
  // The naive "dedup against acceptedComments" suppresses a scanner finding
  // whenever an AI comment lands near it — even if the AI comment is itself
  // about to be dropped by the cap. End result of the naive flow: a critical
  // scanner finding silently lost because a 'minor' AI comment in the same
  // neighborhood "won" dedup and then got chopped by the cap.
  //
  // Fix: predict-then-dedup. We run filterComments() over the AI-only list
  // first to compute which AI comments survive, then dedup scanner findings
  // against THAT smaller set. Caps run a second time over the combined list
  // below — that's the one whose output actually gets posted. The first
  // filterComments() call is a prediction; only its `kept` is consumed.
  const aiPredictedSurvivors = filterComments(aggregator.acceptedComments, {
    severityFloor: config.severity.floor,
    maxCommentsPerFile: config.severity.max_comments_per_file,
    maxCommentsTotal: config.severity.max_comments_total,
  }).kept;
  const dedupedFindings = dedupScannerFindings({
    scanFindings: scanRunResult.findings,
    aiComments: aiPredictedSurvivors,
  });

  // Validate + adapt surviving findings, then push into the same aggregator
  // so the existing filter pipeline applies to scanner comments too.
  const changedFilesMap = new Map(prContext.files.map((f) => [f.path, f]));
  let addedScannerComments = 0;
  for (const finding of dedupedFindings) {
    const valid = validateScanFinding(finding, { changedFiles: changedFilesMap });
    if (!valid.ok) {
      await logger.debug(
        `Skipping scanner finding from ${finding.scanner}: ${valid.reason}`,
      );
      continue;
    }
    aggregator.addComment(scanFindingToPostedComment(finding));
    addedScannerComments += 1;
  }

  if (scanners.length > 0) {
    const scannerErrors = scanRunResult.perScanner.flatMap((r) => r.errors);
    await logger.info(
      `Scanners finished: ${scanners.length} run, ${scanRunResult.findings.length} unique finding(s), ` +
        `${addedScannerComments} added to review` +
        (scannerErrors.length > 0 ? `, ${scannerErrors.length} non-fatal error(s)` : ''),
    );
  }

  // Apply final filters (severity floor, per-file cap, global cap, dedup) over
  // the combined AI + scanner list. This is the kept-list that actually ships.
  const filtered = filterComments(aggregator.acceptedComments, {
    severityFloor: config.severity.floor,
    maxCommentsPerFile: config.severity.max_comments_per_file,
    maxCommentsTotal: config.severity.max_comments_total,
  });

  const rendered = renderSummary({
    draft: aggregator.snapshot(),
    keptComments: filtered.kept,
    truncatedCount: filtered.dropped,
    configEvent: config.review.event,
    modelName: config.model,
  });

  // Dry run: log instead of posting
  if (input.dry_run) {
    await logDryRunReview({
      event: rendered.event,
      body: rendered.body,
      comments: filtered.kept,
      draft: aggregator.snapshot(),
    });
    return {
      comment_count: filtered.kept.length,
      ended: result.ended,
      turns: result.turns,
      cost_usd: result.costUsd,
      dry_run: true,
    };
  }

  // Sticky: dismiss prior agent reviews before posting the new one
  if (config.review.sticky) {
    try {
      const dismissed = await dismissPriorAgentReviews(
        octokit,
        { owner: input.owner, repo: input.repo, pull_number: input.pull_number },
        prContext.metadata.head_sha,
      );
      if (dismissed > 0) {
        await logger.info(`Dismissed ${dismissed} prior agent review(s).`);
      }
    } catch (err) {
      await logger.warn(`Failed to dismiss prior reviews: ${(err as Error).message}`);
    }
  }

  // Post the review
  const posted = await postReview(octokit, {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
    commit_id: prContext.metadata.head_sha,
    event: rendered.event,
    body: rendered.body,
    comments: filtered.kept,
  });

  await logger.info(`Posted review ${posted.review_id} with ${posted.comment_count} inline comment(s).`);

  return {
    review_id: posted.review_id,
    comment_count: posted.comment_count,
    ended: result.ended,
    turns: result.turns,
    cost_usd: result.costUsd,
    dry_run: false,
  };
}

async function loadConfig(
  input: OrchestratorInput,
  fileReader: FileReader,
  headSha: string,
): Promise<ReviewConfig> {
  // First try fetching from the PR head via GitHub Contents API (CI mode)
  try {
    const content = await fileReader.read({
      owner: input.owner,
      repo: input.repo,
      path: input.config_path,
      ref: headSha,
    });
    if (content != null) {
      return loadConfigFromString(content);
    }
  } catch (err) {
    await logger.debug(`Could not read ${input.config_path} from GitHub: ${(err as Error).message}`);
  }

  // Fallback: local file in workspace (useful for local testing)
  try {
    const localPath = resolve(input.workspace_dir, input.config_path);
    const content = await readFile(localPath, 'utf-8');
    return loadConfigFromString(content);
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadRepoContextFiles(
  fileReader: FileReader,
  owner: string,
  repo: string,
  ref: string,
  files: string[],
): Promise<RepoContextEntry[]> {
  const entries: RepoContextEntry[] = [];
  for (const file of files) {
    const content = await fileReader.read({ owner, repo, path: file, ref });
    if (content != null) {
      entries.push({ file, content });
    }
  }
  return entries;
}

