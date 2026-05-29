#!/usr/bin/env node
/**
 * Captured-PR eval with the REAL LLM through `runOrchestrator`. Complements
 * `scripts/golden/eval.ts` (which calls `runAgent` directly, bypassing the
 * scanner pipeline + experimental flags) by exercising the full orchestrator
 * code-path on captured PRs.
 *
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/captured-real.ts
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/captured-real.ts --case vor-pr-6
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/captured-real.ts --scanner-findings-in-user-prompt
 *
 * For each captured case it:
 *   1. Loads `meta.yml`, `pr.json.data`, `files.json.data`, `diff.patch`.
 *   2. Builds a FakeOctokit serving those bytes, with `repos.getContent`
 *      backed by `git show <ref>:<path>` against the case's `repo/` snapshot.
 *      A synthetic `.vor.yml` is injected when the experimental flag
 *      is requested so the orchestrator picks it up at HEAD without git churn.
 *   3. Runs `runOrchestrator` with `dry_run: true`.
 *   4. Compares the kept comments against `codex/normalized.json` to get
 *      agreement-rate / ours-only / codex-only deltas.
 *
 * Cost discipline: one real LLM call per case. Sonnet on the 3 captured cases
 * is typically $0.40-$0.80 total per A/B side.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Octokit } from '@octokit/rest';
import type { PostedComment } from '../../src/types.js';
import { runOrchestrator } from '../../src/orchestrator.js';
import { compare, type CompareResult } from '../../src/eval/compare.js';
import { fromPostedComment, type NormalizedFinding } from '../../src/eval/finding.js';
import { ensureRepoSnapshot, type CaseMeta } from '../../src/eval/local-deps.js';
import { injectScannerFindingsFlag } from './flag-injection.js';
import { assertOutsidePublicRepo } from './golden-path-guard.js';

interface Args {
  goldenRepo: string;
  caseFilter?: string;
  model?: string;
  maxTurns?: number;
  output: string;
  scannerFindingsInUserPrompt: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const a = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const goldenRepo = process.env.GOLDEN_REPO_PATH ?? '../vor-golden';
  const maxTurnsRaw = a('--max-turns');
  return {
    goldenRepo: resolve(goldenRepo),
    ...(a('--case') !== undefined ? { caseFilter: a('--case') } : {}),
    ...(a('--model') !== undefined ? { model: a('--model') } : {}),
    ...(maxTurnsRaw !== undefined ? { maxTurns: Number.parseInt(maxTurnsRaw, 10) } : {}),
    output: a('--output', `${goldenRepo}/reports/captured-real-${ts}.json`)!,
    scannerFindingsInUserPrompt: argv.includes('--scanner-findings-in-user-prompt'),
  };
}

function listCapturedCases(casesRoot: string, filter?: string): string[] {
  if (!existsSync(casesRoot)) return [];
  const all = readdirSync(casesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  // Captured = has the committed artifacts (meta.yml + pr.json + files.json
  // + diff.patch). `repo/` is intentionally gitignored in the golden dataset
  // — on a fresh checkout it's missing, so requiring it here would exclude
  // every otherwise-valid case. `runOne()` calls `ensureRepoSnapshot()` to
  // clone the source repo at the captured head SHA before `git show` reads.
  const captured = all.filter((id) => {
    const dir = resolve(casesRoot, id);
    return (
      existsSync(resolve(dir, 'meta.yml')) &&
      existsSync(resolve(dir, 'pr.json')) &&
      existsSync(resolve(dir, 'files.json')) &&
      existsSync(resolve(dir, 'diff.patch'))
    );
  });
  return filter ? captured.filter((id) => id === filter) : captured;
}

interface CapturedArtifacts {
  meta: CaseMeta;
  prData: Record<string, unknown>;
  filesData: Array<{
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string | null;
    status?: string;
  }>;
  diff: string;
  codexFindings: NormalizedFinding[];
}

function loadCapturedArtifacts(caseDir: string): CapturedArtifacts {
  const meta = parseYaml(readFileSync(resolve(caseDir, 'meta.yml'), 'utf-8')) as CaseMeta;
  const prJson = JSON.parse(readFileSync(resolve(caseDir, 'pr.json'), 'utf-8')) as {
    data: Record<string, unknown>;
  };
  const filesJson = JSON.parse(readFileSync(resolve(caseDir, 'files.json'), 'utf-8')) as {
    data: CapturedArtifacts['filesData'];
  };
  const diff = readFileSync(resolve(caseDir, 'diff.patch'), 'utf-8');
  const codexNormalizedPath = resolve(caseDir, 'codex', 'normalized.json');
  const codexFindings = existsSync(codexNormalizedPath)
    ? (JSON.parse(readFileSync(codexNormalizedPath, 'utf-8')) as NormalizedFinding[])
    : [];
  return { meta, prData: prJson.data, filesData: filesJson.data, diff, codexFindings };
}

function gitShow(repoDir: string, ref: string, path: string): string | null {
  // Use the argv form so paths containing spaces or shell metacharacters
  // (a-repo can legitimately have `src/foo bar.ts` or paths the agent
  // requests through tool calls) don't get word-split or interpreted by
  // the shell. Codex P2 #3311351356 on PR #34.
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function buildFakeOctokit(opts: {
  artifacts: CapturedArtifacts;
  repoDir: string;
  configOverride?: string;
}): Octokit {
  const { artifacts, repoDir, configOverride } = opts;
  return {
    rest: {
      pulls: {
        get: async (args: { mediaType?: { format?: string } }) => {
          if (args.mediaType?.format === 'diff') {
            return { data: artifacts.diff as unknown };
          }
          return { data: artifacts.prData };
        },
        // Real `fetchPRFiles` paginates until a page returns fewer than 100
        // entries. Honor `page` / `per_page` so captured PRs with many files
        // (or `per_page < total`) don't loop forever.
        listFiles: async (args: { page?: number; per_page?: number } = {}) => {
          const perPage = args.per_page ?? 30;
          const page = args.page ?? 1;
          const start = (page - 1) * perPage;
          return { data: artifacts.filesData.slice(start, start + perPage) };
        },
        listReviews: async () => ({ data: [] }),
        createReview: async () => ({ data: { id: 0 } }),
        dismissReview: async () => ({ data: {} }),
      },
      repos: {
        getContent: async (args: { path: string; ref?: string }) => {
          // Synthetic `.vor.yml` for flag injection takes precedence.
          if (args.path === '.vor.yml' && configOverride !== undefined) {
            return {
              data: {
                type: 'file',
                content: Buffer.from(configOverride, 'utf-8').toString('base64'),
                encoding: 'base64',
              },
            };
          }
          const ref = args.ref ?? artifacts.meta.head_sha;
          const content = gitShow(repoDir, ref, args.path);
          if (content === null) {
            const err = Object.assign(new Error('Not Found'), { status: 404 });
            throw err;
          }
          return {
            data: {
              type: 'file',
              content: Buffer.from(content, 'utf-8').toString('base64'),
              encoding: 'base64',
            },
          };
        },
      },
    },
  } as unknown as Octokit;
}

interface CaseResult {
  case_id: string;
  cost_usd: number;
  turns: number;
  ended: string;
  kept_count: number;
  codex_count: number;
  matched: number;
  ours_only: number;
  codex_only: number;
  agreement_rate: number;
  comparison: CompareResult;
}

async function runOne(caseId: string, goldenRepo: string, args: Args): Promise<CaseResult> {
  const caseDir = resolve(goldenRepo, 'cases', caseId);
  const repoDir = resolve(caseDir, 'repo');
  // Auto-restore the source-code snapshot when missing. The golden dataset
  // gitignores `cases/*/repo/` to keep private code out of the dataset repo,
  // so on a fresh checkout `repo/` doesn't exist yet. Mirrors what
  // `golden:eval` does at the top of its per-case loop. Requires GH_TOKEN
  // / GITHUB_TOKEN in env when cloning is needed.
  await ensureRepoSnapshot({ caseDir });
  const artifacts = loadCapturedArtifacts(caseDir);

  // When the flag is requested, merge the experimental key INTO the repo's
  // real `.vor.yml` rather than replacing it. Codex caught this on
  // PR #34: the earlier behavior overwrote everything (severity floor,
  // exclude paths, scanner enables) the repo had configured. Plus the
  // round-trip through the real loader lets us warn when the flag has no
  // schema-level effect on the current branch.
  let configOverride: string | undefined;
  if (args.scannerFindingsInUserPrompt) {
    const existingYaml = gitShow(repoDir, artifacts.meta.head_sha, '.vor.yml');
    const inj = injectScannerFindingsFlag(existingYaml);
    configOverride = inj.mergedYaml;
    if (!inj.effective) {
      console.error(
        `  WARN: --scanner-findings-in-user-prompt requested but the current branch's ` +
          `config schema does not expose 'experimental.scanner_findings_in_user_prompt'. ` +
          `The flag is being stripped by Zod and the run is identical to flag-OFF. ` +
          `Land the flag implementation (PR #36) before A/B-ing on this branch.`,
      );
    }
  }

  const fakeOctokit = buildFakeOctokit({
    artifacts,
    repoDir,
    ...(configOverride !== undefined ? { configOverride } : {}),
  });

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  if (!anthropicKey && !openaiKey) {
    throw new Error('ANTHROPIC_API_KEY or OPENAI_API_KEY must be set');
  }

  console.error(
    `\n=== ${caseId} (${artifacts.filesData.length} file(s), ${artifacts.codexFindings.length} codex finding(s)) ===`,
  );

  const result = await runOrchestrator({
    owner: artifacts.meta.owner,
    repo: artifacts.meta.repo,
    pull_number: artifacts.meta.pull_number,
    anthropic_api_key: anthropicKey,
    openai_api_key: openaiKey,
    github_token: 'captured-eval-placeholder',
    ...(args.model !== undefined ? { model_override: args.model } : {}),
    ...(args.maxTurns !== undefined ? { max_turns_override: args.maxTurns } : {}),
    config_path: '.vor.yml',
    dry_run: true,
    workspace_dir: repoDir,
    octokitFactory: () => fakeOctokit,
  });

  // Reject the orchestrator's "skipped" outcomes. The entry-level OR check
  // can't tell which provider the case's model resolves to; if the resolved
  // provider's key is missing, runOrchestrator returns ended=skipped_no_key_*
  // with zero cost / zero findings, which would silently look like a clean
  // eval. Same for draft-PR / fork-skip edges. Codex P2 #3311419655.
  if (result.ended.startsWith('skipped_')) {
    throw new Error(
      `orchestrator returned ${result.ended} — no review actually ran. ` +
        `Check that the API key for the resolved provider (model=${args.model ?? 'snapshot config'}) is set.`,
    );
  }

  const oursNormalized = result.kept_comments.map((c: PostedComment) => fromPostedComment(c));
  const comparison = compare({
    ours: oursNormalized,
    codex: artifacts.codexFindings,
    diff: artifacts.diff,
  });

  return {
    case_id: caseId,
    cost_usd: result.cost_usd,
    turns: result.turns,
    ended: result.ended,
    kept_count: result.kept_comments.length,
    codex_count: artifacts.codexFindings.length,
    matched: comparison.totals.matched,
    ours_only: comparison.ours_only.length,
    codex_only: comparison.codex_only.length,
    agreement_rate: comparison.totals.agreement_rate,
    comparison,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Refuse to run if either the dataset path OR the output destination
  // points into this public repo. The captured eval emits a JSON report
  // whose `cases[].comparison` contains normalized Codex finding bodies
  // and `raw` blobs from real captured reviews — leaking those into the
  // public worktree is exactly what the existing `golden:eval` guard
  // protects against. Codex P2 #3311625847.
  assertOutsidePublicRepo(args.goldenRepo, 'GOLDEN_REPO_PATH');
  assertOutsidePublicRepo(args.output, '--output');

  const casesRoot = resolve(args.goldenRepo, 'cases');
  const cases = listCapturedCases(casesRoot, args.caseFilter);
  if (cases.length === 0) {
    console.error(`No captured cases found at ${casesRoot}.`);
    process.exit(2);
  }

  console.error(
    `captured-real: running ${cases.length} case(s) against real LLM` +
      (args.scannerFindingsInUserPrompt ? ' (scanner_findings_in_user_prompt=ON)' : ''),
  );

  const results: CaseResult[] = [];
  const failures: Array<{ case_id: string; error: string }> = [];
  for (const caseId of cases) {
    try {
      results.push(await runOne(caseId, args.goldenRepo, args));
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ERROR on ${caseId}: ${msg}`);
      failures.push({ case_id: caseId, error: msg });
    }
  }

  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
  const totalTurns = results.reduce((s, r) => s + r.turns, 0);
  console.error('\n=== SUMMARY ===');
  for (const r of results) {
    console.error(
      `  ${r.case_id.padEnd(30)} ${r.turns}t  $${r.cost_usd.toFixed(4)}  ` +
        `kept=${r.kept_count}  codex=${r.codex_count}  matched=${r.matched}  ` +
        `agreement=${r.agreement_rate.toFixed(2)}`,
    );
  }
  console.error(
    `\n  TOTAL: ${totalTurns}t  $${totalCost.toFixed(4)} across ${results.length} case(s)`,
  );
  if (failures.length > 0) {
    console.error(`\n  FAILED: ${failures.length} case(s)`);
    for (const f of failures) console.error(`    ${f.case_id}: ${f.error}`);
  }

  const outPath = resolve(args.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        model: args.model ?? 'default',
        flag_scanner_findings_in_user_prompt: args.scannerFindingsInUserPrompt,
        total_cost_usd: totalCost,
        total_turns: totalTurns,
        cases: results,
        failures,
      },
      null,
      2,
    ),
  );
  console.error(`\nReport: ${outPath}`);
  // Exit non-zero if ANY requested case failed to run — totals over only
  // successful cases would otherwise make a partial eval look like a clean
  // pass in automation. Codex P2 #3311303341 on PR #34.
  if (failures.length > 0) process.exit(1);
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
