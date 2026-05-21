/**
 * Run `golden:capture` for each candidate produced by `discover.ts`.
 *
 * Reads a JSON array from stdin (or `--from <file>`), iterates, and shells
 * out to the existing capture script for each entry. Continues on per-case
 * errors so one bad PR doesn't stop the run.
 *
 *   npx tsx scripts/golden/discover.ts --owner driches \
 *     | npx tsx scripts/golden/capture-batch.ts
 *
 *   # or from a file
 *   npx tsx scripts/golden/capture-batch.ts --from candidates.json
 *
 * Required env: GH_TOKEN (or GITHUB_TOKEN), GOLDEN_REPO_PATH.
 *
 * Exit code:
 *   0  — all captures succeeded (or input was empty)
 *   1  — usage error / no input
 *   2  — at least one capture failed (other captures still attempted)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Candidate {
  owner: string;
  repo: string;
  pull_number: number;
  case_id: string;
  title?: string;
}

interface Args {
  from?: string;
  bot: string;
  force: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = args.from ? readFileSync(args.from, 'utf-8') : await readStdin();
  const candidates = parseCandidates(input);

  if (candidates.length === 0) {
    log('No candidates — nothing to do.');
    process.exit(0);
  }

  log(`Capturing ${candidates.length} PR(s)...`);
  const captureScript = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    'capture.ts',
  );

  const failures: Array<{ candidate: Candidate; error: string }> = [];
  for (const c of candidates) {
    log(`\n--- ${c.owner}/${c.repo}#${c.pull_number} → ${c.case_id} ---`);
    const captureArgs = [
      captureScript,
      '--pr',
      `${c.owner}/${c.repo}#${c.pull_number}`,
      '--case-id',
      c.case_id,
      '--bot',
      args.bot,
    ];
    if (args.force) captureArgs.push('--force');

    const result = spawnSync('npx', ['tsx', ...captureArgs], {
      stdio: 'inherit',
      env: process.env,
    });

    if (result.status !== 0) {
      const msg = `capture exited ${result.status}`;
      log(`  ! ${c.case_id}: ${msg}`);
      failures.push({ candidate: c, error: msg });
    }
  }

  log(`\nDone. ${candidates.length - failures.length}/${candidates.length} captured.`);
  if (failures.length > 0) {
    log('Failures:');
    for (const f of failures) {
      log(`  - ${f.candidate.case_id}: ${f.error}`);
    }
    process.exit(2);
  }
}

function parseArgs(argv: readonly string[]): Args {
  let from: string | undefined;
  let bot = 'codex';
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--bot') bot = argv[++i] ?? bot;
    else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') {
      console.error(USAGE);
      process.exit(0);
    } else die(`Unknown argument: ${a}\n${USAGE}`);
  }
  return { ...(from ? { from } : {}), bot, force };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((res, rej) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => res(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', rej);
  });
}

function parseCandidates(text: string): Candidate[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    die(`Could not parse input as JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) die('Input must be a JSON array.');
  return parsed.map((c, i) => {
    if (
      !c ||
      typeof c !== 'object' ||
      typeof (c as Candidate).owner !== 'string' ||
      typeof (c as Candidate).repo !== 'string' ||
      typeof (c as Candidate).pull_number !== 'number' ||
      typeof (c as Candidate).case_id !== 'string'
    ) {
      die(`Candidate at index ${i} is missing required fields (owner, repo, pull_number, case_id).`);
    }
    return c as Candidate;
  });
}

function log(msg: string): void {
  console.log(`[capture-batch] ${msg}`);
}

function die(msg: string): never {
  console.error(`[capture-batch] ${msg}`);
  process.exit(1);
}

const USAGE = `
Usage:
  tsx scripts/golden/discover.ts --owner <login> | tsx scripts/golden/capture-batch.ts
  tsx scripts/golden/capture-batch.ts --from candidates.json

Options:
  --from <file>   Read candidate JSON from file instead of stdin.
  --bot <name>    Bot to pass through to capture.ts (default: codex).
  --force         Pass --force through to each capture (re-baselines existing cases).

Required env: GH_TOKEN (or GITHUB_TOKEN), GOLDEN_REPO_PATH.
`;

await main().catch((err: Error) => {
  console.error(`[capture-batch] ${err.stack ?? err.message}`);
  process.exit(1);
});
