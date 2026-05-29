/**
 * Discover PRs across an owner's repos that have BOTH a Codex review and a
 * driches/vor review — i.e., PRs that are eligible for golden-dataset
 * capture.
 *
 *   npm run golden:discover -- \
 *     --owner driches \
 *     [--bot chatgpt-codex-connector[bot]] \
 *     [--lookback-days 7] \
 *     [--repo-filter '^orbit'] \
 *     [--golden-path /path/to/vor-golden] \
 *     [--limit 50]
 *
 * Output: JSON array on stdout, one entry per eligible PR:
 *   [{ "owner": "...", "repo": "...", "pull_number": N, "case_id": "<repo>-pr-<N>", "title": "...", "head_sha": "..." }, ...]
 *
 * PRs already present at `<golden-path>/cases/<case_id>/meta.yml` are skipped
 * (so re-runs are idempotent).
 *
 * Detection:
 *   - Codex review     → review.user.login matches --bot
 *   - Our reviewer     → review.body contains AGENT_REVIEW_MARKER
 *
 * Required env: GH_TOKEN or GITHUB_TOKEN with read access to source repos.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOctokit } from '../../src/github/client.js';
import { AGENT_REVIEW_MARKER } from '../../src/github/prior-reviews.js';

interface Args {
  owner: string;
  bot: string;
  lookbackDays: number;
  repoFilter?: RegExp;
  goldenPath?: string;
  limit: number;
  state: 'merged' | 'closed' | 'all';
  verbose: boolean;
}

interface Candidate {
  owner: string;
  repo: string;
  pull_number: number;
  case_id: string;
  title: string;
  head_sha: string;
  merged_at: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) die('GH_TOKEN or GITHUB_TOKEN is required.');

  const octokit = createOctokit({ auth: token });
  const since = new Date(Date.now() - args.lookbackDays * 86_400_000);

  vlog(args, `Listing repos for ${args.owner}...`);
  const repos = await listRepos(octokit, args.owner);
  const repoNames = args.repoFilter ? repos.filter((r) => args.repoFilter!.test(r)) : repos;
  vlog(args, `  ${repoNames.length} repo(s) to scan${args.repoFilter ? ' (filtered)' : ''}`);

  const candidates: Candidate[] = [];
  let scanned = 0;
  for (const repo of repoNames) {
    if (candidates.length >= args.limit) break;
    try {
      const found = await scanRepo(octokit, args, repo, since);
      scanned += found.scanned;
      for (const c of found.candidates) {
        if (candidates.length >= args.limit) break;
        if (args.goldenPath && isAlreadyCaptured(args.goldenPath, c.case_id)) {
          vlog(
            args,
            `  skip ${c.owner}/${c.repo}#${c.pull_number} — already captured as ${c.case_id}`,
          );
          continue;
        }
        candidates.push(c);
        vlog(args, `  candidate: ${c.owner}/${c.repo}#${c.pull_number} (${c.case_id})`);
      }
    } catch (err) {
      vlog(args, `  ! ${repo}: ${(err as Error).message}`);
    }
  }

  vlog(args, `Scanned ${scanned} PR(s), found ${candidates.length} new candidate(s).`);
  process.stdout.write(JSON.stringify(candidates, null, 2) + '\n');
}

function parseArgs(argv: readonly string[]): Args {
  let owner = '';
  let bot = 'chatgpt-codex-connector[bot]';
  let lookbackDays = 7;
  let repoFilter: RegExp | undefined;
  let goldenPath: string | undefined;
  let limit = 50;
  let state: Args['state'] = 'merged';
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') owner = argv[++i] ?? '';
    else if (a === '--bot') bot = argv[++i] ?? bot;
    else if (a === '--lookback-days') lookbackDays = Number.parseInt(argv[++i] ?? '7', 10);
    else if (a === '--repo-filter') repoFilter = new RegExp(argv[++i] ?? '');
    else if (a === '--golden-path') goldenPath = argv[++i];
    else if (a === '--limit') limit = Number.parseInt(argv[++i] ?? '50', 10);
    else if (a === '--state') state = (argv[++i] as Args['state']) ?? 'merged';
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--help' || a === '-h') {
      console.error(USAGE);
      process.exit(0);
    } else die(`Unknown argument: ${a}\n${USAGE}`);
  }
  if (!owner) die(`--owner is required\n${USAGE}`);
  return { owner, bot, lookbackDays, repoFilter, goldenPath, limit, state, verbose };
}

async function listRepos(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
): Promise<string[]> {
  // listForAuthenticatedUser is the only call that returns the auth'd user's
  // private repos. listForUser filters to public repos when the username
  // matches the auth'd user (a long-standing API quirk).
  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    affiliation: 'owner',
    sort: 'pushed',
    direction: 'desc',
    per_page: 100,
  });
  return repos.filter((r) => r.owner?.login === owner).map((r) => r.name);
}

const REVIEW_FETCH_CONCURRENCY = 8;

async function scanRepo(
  octokit: ReturnType<typeof createOctokit>,
  args: Args,
  repo: string,
  since: Date,
): Promise<{ candidates: Candidate[]; scanned: number }> {
  // List PRs sorted by updated desc, then check reviews in parallel chunks.
  // The previous version was strictly serial (N+1: one paginated listReviews
  // call per PR), which made a 60-repo / 200-PR scan take 30s+. Chunked
  // parallelism keeps ordering deterministic enough while reducing wall time
  // ~Nx (bounded by REVIEW_FETCH_CONCURRENCY to stay polite to the API).
  const stateFilter = args.state === 'merged' ? 'closed' : args.state;
  const prsToCheck: Array<{
    number: number;
    title: string;
    head_sha: string;
    merged_at: string | null;
  }> = [];

  let page = 1;
  outer: while (true) {
    const r = await octokit.rest.pulls.list({
      owner: args.owner,
      repo,
      state: stateFilter,
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
      page,
    });
    if (r.data.length === 0) break;
    for (const pr of r.data) {
      const updated = new Date(pr.updated_at);
      if (updated < since) break outer;
      if (args.state === 'merged' && !pr.merged_at) continue;
      prsToCheck.push({
        number: pr.number,
        title: pr.title,
        head_sha: pr.head.sha,
        merged_at: pr.merged_at,
      });
    }
    if (r.data.length < 50) break;
    page += 1;
  }

  const out: Candidate[] = [];
  // Process in fixed-size chunks so we cap in-flight requests at
  // REVIEW_FETCH_CONCURRENCY without an external lib.
  for (let i = 0; i < prsToCheck.length; i += REVIEW_FETCH_CONCURRENCY) {
    const chunk = prsToCheck.slice(i, i + REVIEW_FETCH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (pr) => {
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
          owner: args.owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });
        const hasCodex = reviews.some((rv) => rv.user?.login === args.bot);
        const hasOurs = reviews.some((rv) => (rv.body ?? '').includes(AGENT_REVIEW_MARKER));
        return { pr, eligible: hasCodex && hasOurs };
      }),
    );
    for (const { pr, eligible } of results) {
      if (!eligible) continue;
      out.push({
        owner: args.owner,
        repo,
        pull_number: pr.number,
        case_id: `${repo}-pr-${pr.number}`,
        title: pr.title,
        head_sha: pr.head_sha,
        merged_at: pr.merged_at,
      });
    }
  }

  return { candidates: out, scanned: prsToCheck.length };
}

function isAlreadyCaptured(goldenPath: string, caseId: string): boolean {
  return existsSync(resolve(goldenPath, 'cases', caseId, 'meta.yml'));
}

function vlog(args: Args, msg: string): void {
  if (args.verbose) console.error(`[discover] ${msg}`);
}

function die(msg: string): never {
  console.error(`[discover] ${msg}`);
  process.exit(1);
}

const USAGE = `
Usage:
  npm run golden:discover -- --owner <login> [options]

Options:
  --owner <login>       GitHub user/org whose repos to scan (required).
  --bot <login>         Codex bot user.login (default: chatgpt-codex-connector[bot]).
  --lookback-days <N>   Only consider PRs updated in the last N days (default: 7).
  --repo-filter <re>    Limit to repo names matching this regex.
  --golden-path <path>  Path to vor-golden so already-captured cases are skipped.
  --state <s>           PR state: merged | closed | all (default: merged).
  --limit <N>           Stop after finding N candidates (default: 50).
  -v, --verbose         Log progress to stderr.

Required env: GH_TOKEN or GITHUB_TOKEN.

Output: JSON array of candidates on stdout, one per eligible PR.
`;

await main().catch((err: Error) => {
  console.error(`[discover] ${err.stack ?? err.message}`);
  process.exit(1);
});
