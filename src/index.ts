/**
 * Action entrypoint. Parses GitHub Actions inputs from env vars, locates the
 * PR via GITHUB_EVENT_PATH, and hands off to the orchestrator.
 */

import { readFile } from 'node:fs/promises';
import { runOrchestrator } from './orchestrator.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const anthropic_api_key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const github_token = process.env.GITHUB_TOKEN?.trim() ?? '';
  const dry_run = (process.env.INPUT_DRY_RUN ?? 'false').toLowerCase() === 'true';
  const model_override = process.env.INPUT_MODEL?.trim() || undefined;
  const max_turns_override = parseIntOrUndefined(process.env.INPUT_MAX_TURNS);
  const config_path = process.env.INPUT_CONFIG_PATH?.trim() || '.code-review.yml';
  const workspace_dir = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();

  // Fork-PR safety: no key → exit 0 with a clear message.
  if (!anthropic_api_key) {
    await logger.notice(
      'ANTHROPIC_API_KEY is not set. Skipping review (this is expected on PRs from forks ' +
        'unless you have configured pull_request_target with explicit security review).',
    );
    return;
  }
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
      github_token,
      ...(model_override !== undefined ? { model_override } : {}),
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
