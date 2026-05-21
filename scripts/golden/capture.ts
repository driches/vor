/**
 * Capture a PR end-to-end into the private golden-dataset repo.
 *
 *   npm run golden:capture -- \
 *     --pr <owner>/<repo>#<N> \
 *     --case-id <slug> \
 *     [--bot codex|coderabbit|<login>] \
 *     [--force]
 *
 * Steps:
 *   1. Refuse to overwrite an existing case unless --force.
 *   2. octokit.pulls.get → pr.json + meta.yml (with base+head SHAs).
 *   3. octokit.pulls.listFiles → files.json (raw, NOT post-merge).
 *   4. diff via accept: application/vnd.github.v3.diff → diff.patch.
 *   5. Clone repo via `gh repo clone` (or git clone) to <caseDir>/repo at
 *      head SHA. Depth 100 to make base SHA reachable for read_file_at_ref.
 *   6. octokit.pulls.listReviews + listReviewComments → codex/review.json.
 *   7. Run the chosen BotConfig normalizer → codex/normalized.json.
 *
 * Required env: GH_TOKEN or GITHUB_TOKEN with read access to source repo.
 * Honors:    GOLDEN_REPO_PATH (default: ../code-review-golden).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cloneRepoAtSha } from '../../src/eval/local-deps.js';
import {
  CODERABBIT_BOT,
  CODEX_BOT,
  normalizeReview,
  type BotConfig,
  type CapturedBotReview,
} from '../../src/eval/normalize-codex.js';
import { createOctokit } from '../../src/github/client.js';
import { fetchPullRequestDiff } from '../../src/github/diff-fetcher.js';

interface Args {
  pr: string;
  caseId: string;
  bot: string;
  force: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { owner, repo, pull_number } = parsePR(args.pr);

  const goldenRoot = resolve(process.env.GOLDEN_REPO_PATH ?? '../code-review-golden');
  const caseDir = resolve(goldenRoot, 'cases', args.caseId);
  if (existsSync(caseDir)) {
    if (!args.force) {
      die(
        `Case already exists at ${caseDir}.\n` +
          `Use --force to overwrite (this destroys captured history — proceed only if you mean to re-baseline).`,
      );
    }
    log(`--force: removing existing case dir ${caseDir}`);
    rmSync(caseDir, { recursive: true, force: true });
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) die('GH_TOKEN or GITHUB_TOKEN is required to fetch PR data.');

  const octokit = createOctokit({ auth: token });
  const bot = chooseBot(args.bot);

  log(`Capturing ${owner}/${repo}#${pull_number} → ${caseDir}`);
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(resolve(caseDir, 'codex'), { recursive: true });

  // 1. PR metadata
  log('Fetching PR metadata...');
  const prResp = await octokit.rest.pulls.get({ owner, repo, pull_number });
  const baseSha = prResp.data.base.sha;
  const headSha = prResp.data.head.sha;
  writeFileSync(resolve(caseDir, 'pr.json'), JSON.stringify(prResp, null, 2));

  // 2. Files list (raw listFiles, NOT post-merge ChangedFile[])
  log('Fetching file list...');
  type ListFilesData = Awaited<ReturnType<typeof octokit.rest.pulls.listFiles>>['data'];
  const allFiles: ListFilesData = [];
  let page = 1;
  for (;;) {
    const r = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100,
      page,
    });
    allFiles.push(...r.data);
    if (r.data.length < 100) break;
    page += 1;
  }
  writeFileSync(resolve(caseDir, 'files.json'), JSON.stringify({ data: allFiles }, null, 2));

  // 3. Unified diff
  log('Fetching unified diff...');
  const diff = await fetchPullRequestDiff(octokit, { owner, repo, pull_number });
  writeFileSync(resolve(caseDir, 'diff.patch'), diff);

  // 4. Reviews and comments (raw — we filter to the bot when normalizing)
  log(`Fetching reviews and inline comments (filtering to bot user: ${bot.userLogin})...`);
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  const allComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  const captured: CapturedBotReview = {
    bot_user: bot.userLogin,
    reviews: allReviews
      .filter((r) => r.user?.login === bot.userLogin)
      .map((r) => ({
        id: r.id,
        body: r.body ?? null,
        state: r.state,
        user: r.user ? { login: r.user.login } : null,
        submitted_at: r.submitted_at ?? null,
      })),
    comments: allComments
      .filter((c) => c.user?.login === bot.userLogin)
      .map((c) => ({
        id: c.id,
        path: c.path,
        line: c.line ?? null,
        start_line: c.start_line ?? null,
        // Preserved so comments outdated by later commits still have a usable
        // line — GitHub nulls `line`/`start_line` in that case. See
        // normalize-codex.ts → normalizeComment for the fallback chain.
        original_line: c.original_line ?? null,
        original_start_line: c.original_start_line ?? null,
        side: c.side ?? undefined,
        body: c.body,
        user: c.user ? { login: c.user.login } : null,
        ...(c.in_reply_to_id !== undefined ? { in_reply_to_id: c.in_reply_to_id } : {}),
      })),
  };
  writeFileSync(resolve(caseDir, 'codex/review.json'), JSON.stringify(captured, null, 2));
  log(`  → ${captured.reviews.length} review(s), ${captured.comments.length} inline comment(s)`);

  // 5. Normalize Codex comments
  const normalized = normalizeReview({ captured, bot });
  writeFileSync(
    resolve(caseDir, 'codex/normalized.json'),
    JSON.stringify(normalized, null, 2),
  );
  log(`  → ${normalized.length} normalized finding(s)`);

  // 6. Clone source repo at head SHA (snapshot). cloneRepoAtSha passes the
  //    token via env (not argv), so it doesn't leak to `ps`.
  const repoDir = resolve(caseDir, 'repo');
  log(`Cloning ${owner}/${repo} → ${repoDir} (depth 100)...`);
  cloneRepoAtSha({ owner, repo, headSha, dest: repoDir, token });

  // 7. meta.yml — written last so a partial capture doesn't look complete
  writeFileSync(
    resolve(caseDir, 'meta.yml'),
    [
      `case_id: ${args.caseId}`,
      `pr_url: https://github.com/${owner}/${repo}/pull/${pull_number}`,
      `owner: ${owner}`,
      `repo: ${repo}`,
      `pull_number: ${pull_number}`,
      `base_sha: ${baseSha}`,
      `head_sha: ${headSha}`,
      `captured_at: ${new Date().toISOString()}`,
      `bot_user: ${bot.userLogin}`,
      `bot_display_name: ${bot.displayName}`,
      '',
    ].join('\n'),
  );

  log(`Captured ${args.caseId}.`);
  log(`To run the eval against this case:`);
  log(`  npm run golden:eval -- --case ${args.caseId}`);
}

function parseArgs(argv: readonly string[]): Args {
  let pr = '';
  let caseId = '';
  let bot = 'codex';
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') pr = argv[++i] ?? '';
    else if (a === '--case-id') caseId = argv[++i] ?? '';
    else if (a === '--bot') bot = argv[++i] ?? 'codex';
    else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else die(`Unknown argument: ${a}\n${USAGE}`);
  }
  if (!pr) die(`--pr is required\n${USAGE}`);
  if (!caseId) die(`--case-id is required\n${USAGE}`);
  return { pr, caseId, bot, force };
}

function parsePR(s: string): { owner: string; repo: string; pull_number: number } {
  const m = s.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) die(`--pr must be <owner>/<repo>#<N>, got: ${s}`);
  return { owner: m[1]!, repo: m[2]!, pull_number: Number.parseInt(m[3]!, 10) };
}

function chooseBot(spec: string): BotConfig {
  if (spec === 'codex') return CODEX_BOT;
  if (spec === 'coderabbit') return CODERABBIT_BOT;
  // Treat anything else as a literal user.login with no severity inference;
  // the user can re-run normalization later with a tuned config.
  return {
    userLogin: spec,
    displayName: spec,
    severityRegex: /(?!)/, // never matches
    severityMap: {},
  };
}

function log(msg: string): void {
  console.log(`[capture] ${msg}`);
}

function die(msg: string): never {
  console.error(`[capture] ${msg}`);
  process.exit(1);
}

const USAGE = `
Usage:
  npm run golden:capture -- --pr <owner>/<repo>#<N> --case-id <slug> [--bot <name>] [--force]

Required env:
  GH_TOKEN or GITHUB_TOKEN — must have read access to the source repo.

Honors:
  GOLDEN_REPO_PATH — destination root (default: ../code-review-golden).

Bot names:
  codex (default), coderabbit, or any literal GitHub bot login.
`;

await main().catch((err: Error) => {
  console.error(`[capture] ${err.stack ?? err.message}`);
  process.exit(1);
});
