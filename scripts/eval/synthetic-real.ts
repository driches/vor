#!/usr/bin/env node
/**
 * Synthetic-case eval with the REAL LLM. Mirrors what `scripts/golden/eval.ts`
 * does for captured PRs, but for the synthetic-bug cases (`truth.yml` ground
 * truth) the captured-PR eval can't see because its case-loader requires
 * `meta.yml`.
 *
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/synthetic-real.ts
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/synthetic-real.ts --case mixed-bag
 *   GOLDEN_REPO_PATH=/path/to/golden npx tsx scripts/eval/synthetic-real.ts --model claude-haiku-4-5
 *
 * For each case it:
 *   1. `loadCase()` + `synthesizeDiff()` → diff + files API shape
 *   2. Constructs a FakeOctokit serving those bytes (same pattern as
 *      `scripts/local-review.ts`, plus a synthetic `.code-review.yml`
 *      injection point for flag A/B testing)
 *   3. `runOrchestrator()` with `dry_run: true` and NO `providerFactory` so
 *      the real provider (Anthropic or OpenAI per the model id) runs
 *   4. `scoreRun()` against `truth.yml` → precision / recall / F1
 *   5. Prints per-case and totals
 *
 * Cost discipline: one real LLM call per case. Run sparingly with Sonnet —
 * the 5 synthetic cases at Sonnet defaults cost ~$2-5 per pass.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { PostedComment } from '../../src/types.js';
import { runOrchestrator } from '../../src/orchestrator.js';
import { loadCase } from './case-loader.js';
import { synthesizeDiff } from './diff-synthesis.js';
import { injectScannerFindingsFlag } from './flag-injection.js';
import { scoreRun } from './scoring.js';

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
  const goldenRepo = process.env.GOLDEN_REPO_PATH ?? '../code-review-golden';
  const maxTurnsRaw = a('--max-turns');
  return {
    goldenRepo: resolve(goldenRepo),
    ...(a('--case') !== undefined ? { caseFilter: a('--case') } : {}),
    ...(a('--model') !== undefined ? { model: a('--model') } : {}),
    ...(maxTurnsRaw !== undefined ? { maxTurns: Number.parseInt(maxTurnsRaw, 10) } : {}),
    output: a('--output', `${goldenRepo}/reports/synthetic-real-${ts}.json`)!,
    scannerFindingsInUserPrompt: argv.includes('--scanner-findings-in-user-prompt'),
  };
}

function listSyntheticCases(casesRoot: string, filter?: string): string[] {
  if (!existsSync(casesRoot)) return [];
  const all = readdirSync(casesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const synthetic = all.filter((id) => {
    const dir = resolve(casesRoot, id);
    return (
      existsSync(resolve(dir, 'truth.yml')) &&
      existsSync(resolve(dir, 'before')) &&
      existsSync(resolve(dir, 'after')) &&
      statSync(resolve(dir, 'before')).isDirectory()
    );
  });
  return filter ? synthetic.filter((id) => id === filter) : synthetic;
}

/**
 * Materialize the case's `after/` snapshot as a temporary git checkout so
 * the agent's `grep_repo_at_ref` tool (which shells out to `git grep` from
 * `workspaceDir`) actually works. Without this, every grep call against a
 * synthetic case fails with "not a git repository" and the agent silently
 * loses its caller / pattern-search capability mid-eval. Codex P2 #3311481416.
 *
 * Pointing the orchestrator at the raw `after/` directory broke this; pointing
 * it back at `process.cwd()` broke scanners (they shell out for binaries from
 * `workspace_dir`). Materializing a per-case temp checkout satisfies both.
 */
function materializeSyntheticWorkspace(
  goldenRepo: string,
  caseId: string,
): { dir: string; cleanup: () => void } {
  const afterDir = resolve(goldenRepo, 'cases', caseId, 'after');
  const workDir = mkdtempSync(join(tmpdir(), `synthetic-eval-${caseId}-`));
  cpSync(afterDir, workDir, { recursive: true });
  const gitOpts = { cwd: workDir, stdio: 'ignore' } as const;
  execFileSync('git', ['init', '-q', '-b', 'synthetic'], gitOpts);
  // `-f` so any `.gitignore` shipped in `after/` doesn't cause `git add` to
  // skip its own committed fixtures (e.g. `.env`, generated test inputs).
  // The synthesized diff/files-API expose every file in `after/`, so the
  // materialized commit MUST match that set — otherwise the agent's
  // `grep_repo_at_ref` searches a different tree than what's in the PR.
  // Codex P2 #3311540085.
  execFileSync('git', ['add', '-A', '-f'], gitOpts);
  // Inline identity so the local user's `git config` isn't required to
  // produce a commit. The committed tree is the `after/` snapshot — the
  // tool only needs SOME ref to grep against.
  execFileSync(
    'git',
    // `--allow-empty` so a deletion-only case (empty `after/` snapshot, which
    // `synthesizeDiff` already supports) still produces the HEAD ref that
    // `grep_repo_at_ref` needs. Without it `git commit` exits non-zero and
    // the entire eval case fails before the orchestrator ever runs.
    // Codex P2 #3311582726.
    [
      '-c', 'user.email=eval@local',
      '-c', 'user.name=synthetic-eval',
      'commit', '-q', '--allow-empty', '-m', 'synthetic',
    ],
    gitOpts,
  );
  return {
    dir: workDir,
    cleanup: () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; orphans under tmpdir() are harmless.
      }
    },
  };
}

/**
 * Build a FakeOctokit that serves the synthesized PR. Mirrors local-review's
 * shape but the file content comes from the case's `after/` (and `before/`
 * for base reads) instead of git.
 */
function buildFakeOctokit(opts: {
  diff: string;
  filesApi: Array<{ filename: string; changes: number; patch: string | null | undefined }>;
  fileBytes: Map<string, string>;
  beforeBytes: Map<string, string>;
  configOverride?: string;
  caseId: string;
}): Octokit {
  return {
    rest: {
      pulls: {
        get: async (args: { mediaType?: { format?: string } }) => {
          if (args.mediaType?.format === 'diff') {
            return { data: opts.diff as unknown };
          }
          return {
            data: {
              number: 1,
              title: `Synthetic eval: ${opts.caseId}`,
              body: '',
              user: { login: 'synthetic-eval' },
              draft: false,
              additions: opts.filesApi.reduce((s, f) => s + f.changes, 0),
              deletions: 0,
              changed_files: opts.filesApi.length,
              labels: [],
              head: { sha: 'synthhead', ref: 'after' },
              base: { sha: 'synthbase', ref: 'before' },
            },
          };
        },
        // Real `fetchPRFiles` paginates until a page returns fewer than 100
        // entries. A naive fake that returns the full list on every page
        // would loop forever on synthetic cases with >=100 files. Honor
        // `page` / `per_page` so the loop terminates.
        listFiles: async (args: { page?: number; per_page?: number } = {}) => {
          const perPage = args.per_page ?? 30;
          const page = args.page ?? 1;
          const start = (page - 1) * perPage;
          const slice = opts.filesApi.slice(start, start + perPage);
          return {
            data: slice.map((f) => ({
              filename: f.filename,
              status: 'added',
              additions: f.changes,
              deletions: 0,
              changes: f.changes,
              sha: 'synthhead',
              patch: f.patch,
            })),
          };
        },
        listReviews: async () => ({ data: [] }),
        createReview: async () => ({ data: { id: 0 } }),
        dismissReview: async () => ({ data: {} }),
      },
      repos: {
        getContent: async (args: { path: string; ref?: string }) => {
          // .code-review.yml override (for A/B flag injection)
          if (args.path === '.code-review.yml' && opts.configOverride !== undefined) {
            return {
              data: {
                type: 'file',
                content: Buffer.from(opts.configOverride, 'utf-8').toString('base64'),
                encoding: 'base64',
              },
            };
          }
          const isBase = args.ref === 'synthbase';
          const source = isBase ? opts.beforeBytes : opts.fileBytes;
          const content = source.get(args.path);
          if (content === undefined) {
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
  truth_count: number;
  cost_usd: number;
  turns: number;
  ended: string;
  kept_comments: ReadonlyArray<PostedComment>;
  score: ReturnType<typeof scoreRun>;
}

async function runOne(
  caseId: string,
  goldenRepo: string,
  args: Args,
): Promise<CaseResult> {
  const c = loadCase(goldenRepo, caseId);
  const { diff, filesApi } = synthesizeDiff(c);
  const fileBytes = new Map(c.files.map((f) => [f.path, f.content]));
  const beforeBytes = new Map(c.beforeFiles.map((f) => [f.path, f.content]));

  // Synthetic cases have no committed `.code-review.yml` to merge into, so
  // we feed the helper a null baseline. The helper still round-trips through
  // the real loader, which lets us warn when the flag has no effect on the
  // current branch's schema.
  let configOverride: string | undefined;
  if (args.scannerFindingsInUserPrompt) {
    const inj = injectScannerFindingsFlag(null);
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
    diff,
    filesApi,
    fileBytes,
    beforeBytes,
    ...(configOverride !== undefined ? { configOverride } : {}),
    caseId,
  });

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  if (!anthropicKey && !openaiKey) {
    throw new Error('ANTHROPIC_API_KEY or OPENAI_API_KEY must be set');
  }

  console.error(`\n=== ${caseId} (${filesApi.length} file(s), ${c.truths.length} truth(s)) ===`);

  // The materialized workspace satisfies BOTH constraints the orchestrator
  // imposes on `workspace_dir`:
  //   - SAST scanners shell out from here to locate `node_modules/.bin` and
  //     to resolve relative paths in scanner output, so it has to be a real
  //     directory containing the case's planted files (not `process.cwd()`,
  //     which is the code-review checkout).
  //   - The agent's `grep_repo_at_ref` tool runs `git grep` from here, so
  //     the directory has to be a git repository (not the raw `after/`
  //     snapshot, which isn't). Codex P2 #3311481416.
  const workspace = materializeSyntheticWorkspace(goldenRepo, caseId);
  try {
    const result = await runOrchestrator({
      owner: 'synthetic',
      repo: caseId,
      pull_number: 1,
      anthropic_api_key: anthropicKey,
      openai_api_key: openaiKey,
      github_token: 'synthetic-eval-placeholder',
      ...(args.model !== undefined ? { model_override: args.model } : {}),
      ...(args.maxTurns !== undefined ? { max_turns_override: args.maxTurns } : {}),
      config_path: '.code-review.yml',
      dry_run: true,
      workspace_dir: workspace.dir,
      octokitFactory: () => fakeOctokit,
    });

    // Reject the orchestrator's "skipped" outcomes. The entry-level OR check
    // (at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY is set) can't tell
    // which provider the model resolves to inside the orchestrator. When the
    // resolved provider's key is empty (e.g. `--model gpt-5-mini` with only
    // ANTHROPIC_API_KEY exported), runOrchestrator returns ended=skipped_no_key_*
    // with zero cost / zero findings — without this check, the harness would
    // record a successful eval, masking a misconfigured run. Same applies to
    // draft-PR skips, which don't apply here but cost nothing to guard against.
    // Codex P2 #3311419655.
    if (result.ended.startsWith('skipped_')) {
      throw new Error(
        `orchestrator returned ${result.ended} — no review actually ran. ` +
          `Check that the API key for the resolved provider (model=${args.model ?? 'default'}) is set.`,
      );
    }

    // OrchestratorOutput now exposes `kept_comments` directly (added so eval
    // harnesses don't need a side channel into the aggregator).
    const kept = result.kept_comments;
    const score = scoreRun({
      case_id: caseId,
      config_name: args.model ?? 'default',
      truths: c.truths,
      findings: kept,
      cost: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        turns: result.turns,
        cost_usd: result.cost_usd,
        wall_ms: 0,
        ended_reason: result.ended,
      },
    });

    return {
      case_id: caseId,
      truth_count: c.truths.length,
      cost_usd: result.cost_usd,
      turns: result.turns,
      ended: result.ended,
      kept_comments: kept,
      score,
    };
  } finally {
    workspace.cleanup();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const casesRoot = resolve(args.goldenRepo, 'cases');
  const cases = listSyntheticCases(casesRoot, args.caseFilter);
  if (cases.length === 0) {
    console.error(`No synthetic cases found at ${casesRoot}.`);
    process.exit(2);
  }

  console.error(
    `synthetic-real: running ${cases.length} case(s) against real LLM` +
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
  const totalTruths = results.reduce((s, r) => s + r.truth_count, 0);
  const totalTp = results.reduce((s, r) => s + r.score.tp, 0);
  const totalFp = results.reduce((s, r) => s + r.score.fp, 0);
  const totalFn = results.reduce((s, r) => s + r.score.fn, 0);
  const overallRecall = totalTruths > 0 ? totalTp / totalTruths : 0;
  const overallPrecision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 0;
  console.error('\n=== SUMMARY ===');
  for (const r of results) {
    const tp = r.score.tp;
    const fp = r.score.fp;
    const fn = r.score.fn;
    console.error(
      `  ${r.case_id.padEnd(30)} ${r.turns}t  $${r.cost_usd.toFixed(4)}  ` +
        `tp=${tp}/${r.truth_count}  fp=${fp}  fn=${fn}  ` +
        `R=${r.score.recall.toFixed(2)}  P=${r.score.precision.toFixed(2)}  F1=${r.score.f1.toFixed(2)}`,
    );
  }
  console.error(
    `\n  TOTAL: ${totalTurns}t  $${totalCost.toFixed(4)}  ` +
      `tp=${totalTp}/${totalTruths}  fp=${totalFp}  fn=${totalFn}  ` +
      `R=${overallRecall.toFixed(2)}  P=${overallPrecision.toFixed(2)} ` +
      `across ${results.length} case(s)`,
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
  // Exit non-zero if ANY requested case failed to run. The totals over only
  // successful cases would otherwise make a partial eval look like a clean
  // pass in automation — Codex P2 #3311303341 on PR #34.
  if (failures.length > 0) process.exit(1);
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
