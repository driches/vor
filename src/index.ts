/**
 * Action entrypoint. Parses GitHub Actions inputs from env vars, locates the
 * PR via GITHUB_EVENT_PATH, and hands off to the orchestrator.
 */

import { readFile } from 'node:fs/promises';
import type { ProviderId } from './llm/types.js';
import { runOrchestrator } from './orchestrator.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const anthropic_api_key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openai_api_key = process.env.OPENAI_API_KEY?.trim() ?? '';
  const github_token = process.env.GITHUB_TOKEN?.trim() ?? '';
  const dry_run = (process.env.INPUT_DRY_RUN ?? 'false').toLowerCase() === 'true';
  const model_override = process.env.INPUT_MODEL?.trim() || undefined;
  // Validate INPUT_PROVIDER at the env-var boundary so a typo like
  // `open-ai` fails with a clear error annotation instead of silently
  // skipping the run later as `skipped_no_key_open-ai`. The orchestrator
  // also runtime-validates `provider_override` as defense-in-depth for
  // any programmatic caller — but the env-var path is the common one
  // and deserves a dedicated, specific error message.
  const raw_provider = process.env.INPUT_PROVIDER?.trim() || undefined;
  if (
    raw_provider !== undefined &&
    raw_provider !== 'anthropic' &&
    raw_provider !== 'openai'
  ) {
    await logger.error(
      `Invalid INPUT_PROVIDER "${raw_provider}". Must be "anthropic" or "openai" (or omit to infer from model id).`,
    );
    process.exitCode = 1;
    return;
  }
  const provider_override: ProviderId | undefined = raw_provider;
  const max_turns_override = parseIntOrUndefined(process.env.INPUT_MAX_TURNS);
  const config_path = process.env.INPUT_CONFIG_PATH?.trim() || '.vor.yml';
  const workspace_dir = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();

  // Manual-only trigger guard. This action is intentionally restricted
  // to manual / programmatic invocation (workflow_dispatch, schedule,
  // repository_dispatch, push). Auto-triggering on every pull_request
  // event historically caused tight review-iteration loops that produced
  // more noise than signal (see commit history of driches/vor
  // for the false-positive pattern that motivated this guard).
  //
  // Opt out by setting `allow_auto_trigger: 'true'` in the action input
  // when you've made an explicit decision that PR-event triggers are
  // appropriate for your repo's review economics.
  //
  // This check fires BEFORE the orchestrator's fork-PR / provider-key
  // checks (those happen post-config-load so they know which provider's
  // key is needed). The manual-only check is event-shape only and has
  // no provider dependency, so we keep it at the top.
  const eventName = process.env.GITHUB_EVENT_NAME?.trim() ?? '';
  const allowAutoTrigger =
    (process.env.INPUT_ALLOW_AUTO_TRIGGER ?? 'true').toLowerCase() === 'true';
  const isPrEvent =
    eventName === 'pull_request' ||
    eventName === 'pull_request_target';
  const isReviewEvent =
    eventName === 'pull_request_review' ||
    eventName === 'pull_request_review_comment';
  if (isReviewEvent) {
    await logger.notice(
      `Refusing to run on '${eventName}' event. Review and review-comment events ` +
        `are never auto-triggered by Vor — they produce review-on-review iteration ` +
        `loops. Use 'on: pull_request' for automatic reviews or ` +
        `'on: workflow_dispatch' for manual ones.`,
    );
    return;
  }
  if (isPrEvent && !allowAutoTrigger) {
    await logger.notice(
      `Refusing to run on '${eventName}' event. Set ` +
        `'allow_auto_trigger: false' is blocking this run. Remove that input (or ` +
        `set it to 'true') to re-enable automatic PR reviews, or use ` +
        `'on: workflow_dispatch' with a pr_number input for manual-only operation.`,
    );
    return;
  }

  // Fork-PR / provider-key safety lives in the orchestrator now (it has to wait
  // until config is loaded so it knows which provider's key matters).
  // github_token still gets checked early — it's needed regardless of provider.
  if (!github_token) {
    await logger.error('GITHUB_TOKEN is not set. Cannot fetch PR or post review.');
    process.exitCode = 1;
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const inputPrNumber = parseIntOrUndefined(process.env.INPUT_PR_NUMBER);
  const inputRepo = process.env.GITHUB_REPOSITORY ?? '';

  let owner = '';
  let repo = '';
  let pull_number = inputPrNumber ?? 0;

  if (inputRepo.includes('/')) {
    const [o, r] = inputRepo.split('/');
    owner = o ?? '';
    repo = r ?? '';
  }

  if (eventPath) {
    try {
      const event = JSON.parse(await readFile(eventPath, 'utf-8'));
      if (event.pull_request?.number) pull_number = event.pull_request.number;
      if (event.repository?.owner?.login) owner = event.repository.owner.login;
      if (event.repository?.name) repo = event.repository.name;
    } catch (err) {
      await logger.warn(`Could not parse GITHUB_EVENT_PATH: ${(err as Error).message}`);
    }
  }

  if (!owner || !repo || !pull_number) {
    await logger.error(
      `Missing owner/repo/pull_number (owner='${owner}', repo='${repo}', pr=${pull_number}). ` +
        'Either run on a pull_request event, or set INPUT_PR_NUMBER and GITHUB_REPOSITORY.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runOrchestrator({
      owner,
      repo,
      pull_number,
      anthropic_api_key,
      openai_api_key,
      github_token,
      ...(model_override !== undefined ? { model_override } : {}),
      ...(provider_override !== undefined ? { provider_override } : {}),
      ...(max_turns_override !== undefined ? { max_turns_override } : {}),
      config_path,
      dry_run,
      workspace_dir,
    });

    await logger.setOutput('review_id', result.review_id ?? '');
    await logger.setOutput('comment_count', result.comment_count);
    await logger.setOutput('ended', result.ended);
    await logger.setOutput('cost_usd', result.cost_usd.toFixed(4));
  } catch (err) {
    await logger.setFailed((err as Error).message);
    if (err instanceof Error && err.stack) {
      await logger.error(err.stack);
    }
  }
}

function parseIntOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
