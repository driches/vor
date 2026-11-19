import type { Command } from 'commander';
import type { ProviderId } from '../../llm/types.js';
import { runBitbucketReview } from '../../bitbucket/review.js';
import { status } from '../output.js';

interface BitbucketReviewFlags {
  workspace?: string;
  repo?: string;
  pr?: string;
  config?: string;
  model?: string;
  provider?: string;
  dryRun?: boolean;
  apiBaseUrl?: string;
}

export function registerBitbucket(program: Command): void {
  const bitbucket = program
    .command('bitbucket')
    .description('Review Bitbucket Cloud pull requests');

  bitbucket
    .command('review')
    .description('Review the current Bitbucket Cloud pull request from Pipelines')
    .option('--workspace <workspace>', 'Bitbucket workspace slug (default: BITBUCKET_WORKSPACE)')
    .option('--repo <repo>', 'Bitbucket repository slug (default: BITBUCKET_REPO_SLUG)')
    .option('--pr <id>', 'Pull request id (default: BITBUCKET_PR_ID)')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)')
    .option('--model <id>', 'Override the review model')
    .option('--provider <provider>', 'LLM provider override (anthropic | openai)')
    .option('--dry-run', 'Log the review instead of posting comments')
    .option(
      '--api-base-url <url>',
      'Bitbucket API base URL (default: https://api.bitbucket.org/2.0)',
    )
    .action(async (flags: BitbucketReviewFlags) => {
      const provider = parseProvider(flags.provider);
      status('Reviewing Bitbucket PR... (running scanners + agent)');
      const result = await runBitbucketReview({
        ...(flags.workspace !== undefined ? { workspace: flags.workspace } : {}),
        ...(flags.repo !== undefined ? { repo: flags.repo } : {}),
        ...(flags.pr !== undefined ? { pr: parseRequiredInt(flags.pr, '--pr') } : {}),
        ...(flags.config !== undefined ? { configPath: flags.config } : {}),
        ...(flags.model !== undefined ? { model: flags.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        dryRun: flags.dryRun ?? false,
        ...(flags.apiBaseUrl !== undefined ? { apiBaseUrl: flags.apiBaseUrl } : {}),
      });
      status(
        `Result: ended=${result.ended}, comments=${result.comment_count}, ` +
          `turns=${result.turns}, cost=$${result.cost_usd.toFixed(4)}`,
      );
    });
}

function parseRequiredInt(raw: string, flag: string): number {
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  const n = Number(normalized);
  if (!Number.isSafeInteger(n)) throw new Error(`${flag} must be a positive integer.`);
  return n;
}

function parseProvider(raw: string | undefined): ProviderId | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const provider = raw.trim();
  if (provider === 'anthropic' || provider === 'openai') return provider;
  throw new Error(`Invalid --provider "${provider}". Must be "anthropic" or "openai".`);
}
