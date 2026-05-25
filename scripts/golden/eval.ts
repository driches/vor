/**
 * Run the code-review agent against captured cases and produce a comparison
 * report against Codex's stored findings.
 *
 *   npm run golden:eval -- --case <case-id>
 *   npm run golden:eval -- --all [--filter <regex>]
 *   npm run golden:eval -- --case <case-id> --model claude-sonnet-4-6
 *
 * For each case:
 *   1. Build LocalDeps from <GOLDEN_REPO_PATH>/cases/<id>/.
 *   2. Run the agent with the case's snapshot config (or DEFAULT_CONFIG).
 *   3. Save the run output to <caseDir>/runs/<timestamp>.json.
 *   4. Load <caseDir>/codex/normalized.json.
 *   5. Compare and accumulate into a single report.
 *   6. Write the report to <GOLDEN_REPO_PATH>/reports/<timestamp>.md.
 *
 * Privacy guard: outputs are only written under GOLDEN_REPO_PATH. The script
 * refuses to run if GOLDEN_REPO_PATH points anywhere inside this public repo.
 *
 * Required env: ANTHROPIC_API_KEY.
 * Honors: GOLDEN_REPO_PATH (default: ../code-review-golden).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAgent } from '../../src/agent/runner.js';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';
import { buildUserPrompt } from '../../src/agent/user-prompt.js';
import { compare } from '../../src/eval/compare.js';
import { fromPostedComment, type NormalizedFinding } from '../../src/eval/finding.js';
import {
  buildLocalDeps,
  ensureRepoSnapshot,
  loadContextFilesForCase,
  type CaseMeta,
} from '../../src/eval/local-deps.js';
import { renderReport, type CaseReport } from '../../src/eval/report.js';
import { filterComments } from '../../src/output/filter.js';
import { renderSummary } from '../../src/output/formatter.js';
import { logger } from '../../src/util/logger.js';
import { parse as parseYaml } from 'yaml';

interface Args {
  case?: string;
  all: boolean;
  filter?: RegExp;
  modelOverride?: string;
  maxTurnsOverride?: number;
  workerDelegation?: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) die('ANTHROPIC_API_KEY is required.');

  const goldenRoot = resolve(process.env.GOLDEN_REPO_PATH ?? '../code-review-golden');
  assertGoldenPathSafe(goldenRoot);

  const casesRoot = resolve(goldenRoot, 'cases');
  if (!existsSync(casesRoot)) {
    die(`No cases directory at ${casesRoot}. Capture a case first with golden:capture.`);
  }

  const caseIds = selectCases(casesRoot, args);
  if (caseIds.length === 0) die('No matching cases found.');
  log(`Evaluating ${caseIds.length} case(s): ${caseIds.join(', ')}`);

  const reportEntries: CaseReport[] = [];
  let modelName = 'unknown';

  for (const id of caseIds) {
    const caseDir = resolve(casesRoot, id);
    // Reject case-ids whose resolved path escapes casesRoot — defends against
    // `--case ../../etc/...` style traversal. Direct children only.
    if (!caseDir.startsWith(casesRoot + '/')) {
      die(`Case id "${id}" resolves outside cases root (${caseDir}) — refusing to proceed.`);
    }
    log(`\n=== ${id} ===`);
    // Auto-restore the source-code snapshot if it's missing (auto-captured
    // cases are committed without `repo/` — gitignored to keep private code
    // out of the dataset repo).
    await ensureRepoSnapshot({ caseDir });
    const built = await buildLocalDeps({ caseDir });
    const { deps, meta, configSource } = built;

    if (args.modelOverride) deps.config.model = args.modelOverride;
    if (args.maxTurnsOverride) deps.config.max_turns = args.maxTurnsOverride;
    if (args.workerDelegation === true) {
      deps.config.experimental.worker_delegation.enabled = true;
    }
    modelName = deps.config.model;

    const contextFiles = await loadContextFilesForCase(deps, deps.config.context.include);
    const systemPrompt = buildSystemPrompt({
      config: deps.config,
      repoName: `${deps.owner}/${deps.repo}`,
      contextFiles,
    });
    const userPrompt = buildUserPrompt({
      owner: deps.owner,
      repo: deps.repo,
      pull_number: deps.pull_number,
    });

    log(
      `Running agent (model=${deps.config.model}, max_turns=${deps.config.max_turns}, config=${configSource})`,
    );
    const agentResult = await runAgent({
      deps,
      systemPrompt,
      userPrompt,
      model: deps.config.model,
      maxTurns: deps.config.max_turns,
      maxInputTokens: deps.config.budget.max_input_tokens,
      maxOutputTokens: deps.config.budget.max_output_tokens,
      apiKey,
    });

    const filtered = filterComments(deps.aggregator.acceptedComments, {
      severityFloor: deps.config.severity.floor,
      maxCommentsPerFile: deps.config.severity.max_comments_per_file,
      maxCommentsTotal: deps.config.severity.max_comments_total,
    });
    const rendered = renderSummary({
      draft: deps.aggregator.snapshot(),
      keptComments: filtered.kept,
      truncatedCount: filtered.dropped,
      configEvent: deps.config.review.event,
      modelName: deps.config.model,
    });

    // Save the run JSON under the private case dir.
    const runDir = resolve(caseDir, 'runs');
    mkdirSync(runDir, { recursive: true });
    const ts = stableTimestamp();
    const runPath = resolve(runDir, `${ts}.json`);
    writeFileSync(
      runPath,
      JSON.stringify(
        {
          timestamp: ts,
          model: deps.config.model,
          configSource,
          ended: agentResult.ended,
          turns: agentResult.turns,
          input_tokens: agentResult.inputTokens,
          output_tokens: agentResult.outputTokens,
          cost_usd: agentResult.costUsd,
          // v0.3.0+: per-model breakdown for Sonnet/Haiku split when worker
          // delegation is enabled. Single-model runs still write this field
          // with one entry so downstream tooling can rely on it existing.
          // Translate from runner's camelCase to the snake_case shape
          // declared by RunRecord in scripts/eval/types.ts — the typed
          // contract downstream readers use.
          per_model_cost: agentResult.perModelCost.map((m) => ({
            model: m.model,
            cost_usd: m.costUsd,
            input_tokens: m.inputTokens,
            output_tokens: m.outputTokens,
            cache_creation_input_tokens: m.cacheCreationTokens,
            cache_read_input_tokens: m.cacheReadTokens,
          })),
          draft: deps.aggregator.snapshot(),
          kept_comments: filtered.kept,
          dropped_comments: filtered.dropped,
          summary_body: rendered.body,
          summary_event: rendered.event,
        },
        null,
        2,
      ),
    );
    log(`  → run saved: ${runPath}`);
    log(
      `  → ${filtered.kept.length} kept comment(s), ${filtered.dropped} dropped, ` +
        `ended=${agentResult.ended}, cost=$${agentResult.costUsd.toFixed(4)}`,
    );
    if (agentResult.perModelCost.length > 1) {
      for (const m of agentResult.perModelCost) {
        log(`    ${m.model}: $${m.costUsd.toFixed(4)}`);
      }
    }

    // Load Codex normalized findings.
    const codexNormPath = resolve(caseDir, 'codex/normalized.json');
    const codex = existsSync(codexNormPath)
      ? (JSON.parse(readFileSync(codexNormPath, 'utf-8')) as NormalizedFinding[])
      : [];
    if (codex.length === 0) {
      log(`  ! no Codex findings found for this case — comparison will be one-sided.`);
    }

    const ours = filtered.kept.map(fromPostedComment);
    const cmp = compare({ ours, codex, diff: deps.prContext.diff });
    log(
      `  → ${cmp.totals.matched} matched, ${cmp.ours_only.length} ours-only, ` +
        `${cmp.codex_only.length} codex-only, agreement=${(cmp.totals.agreement_rate * 100).toFixed(1)}%`,
    );

    reportEntries.push({
      caseId: meta.case_id,
      prUrl: meta.pr_url,
      owner: meta.owner,
      repo: meta.repo,
      pull_number: meta.pull_number,
      result: cmp,
    });
  }

  // Write the combined report.
  const reportsDir = resolve(goldenRoot, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportTs = stableTimestamp();
  const reportPath = resolve(reportsDir, `${reportTs}.md`);
  const md = renderReport({
    cases: reportEntries,
    generatedAt: new Date().toISOString(),
    modelName,
  });
  writeFileSync(reportPath, md);
  log(`\nReport written: ${reportPath}`);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') args.case = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--filter') args.filter = new RegExp(argv[++i] ?? '');
    else if (a === '--model') args.modelOverride = argv[++i];
    else if (a === '--max-turns') args.maxTurnsOverride = Number.parseInt(argv[++i] ?? '0', 10);
    else if (a === '--worker-delegation') args.workerDelegation = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else die(`Unknown argument: ${a}\n${USAGE}`);
  }
  if (!args.case && !args.all) die(`--case <id> or --all is required.\n${USAGE}`);
  return args;
}

function selectCases(casesRoot: string, args: Args): string[] {
  if (args.case) return [args.case];
  const all = readdirSync(casesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  // Verify each candidate looks like a real case (has meta.yml)
  const valid = all.filter((id) => {
    const metaPath = resolve(casesRoot, id, 'meta.yml');
    if (!existsSync(metaPath)) return false;
    try {
      parseYaml(readFileSync(metaPath, 'utf-8')) as Partial<CaseMeta>;
      return true;
    } catch {
      return false;
    }
  });
  return args.filter ? valid.filter((id) => args.filter!.test(id)) : valid;
}

/**
 * Hard refuse to run if the dataset path points at, or inside, this public
 * repo — reports and runs embed snippets from private code. Catches both
 * `<repo>/sub/...` (startsWith check) and the exact-equal case `<repo>` =
 * `<goldenRoot>` (which the original startsWith with trailing slash missed).
 */
function assertGoldenPathSafe(goldenRoot: string): void {
  const here = resolve(process.cwd());
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) return;
  const inside = goldenRoot === repoRoot || goldenRoot.startsWith(repoRoot + '/');
  if (inside) {
    die(
      `GOLDEN_REPO_PATH (${goldenRoot}) is inside or equal to this public repo (${repoRoot}).\n` +
        `Reports and runs contain snippets of private code — point GOLDEN_REPO_PATH at a separate location.`,
    );
  }
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function stableTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(msg: string): void {
  console.log(`[eval] ${msg}`);
  void logger.info(msg);
}

function die(msg: string): never {
  console.error(`[eval] ${msg}`);
  process.exit(1);
}

const USAGE = `
Usage:
  npm run golden:eval -- --case <id>
  npm run golden:eval -- --all [--filter <regex>]

Optional:
  --model <name>      Override the model from .code-review.yml
  --max-turns <N>     Override the agent's max turn count

Required env:
  ANTHROPIC_API_KEY — used to call Claude.

Honors:
  GOLDEN_REPO_PATH — case + report root (default: ../code-review-golden).
`;

await main().catch((err: Error) => {
  console.error(`[eval] ${err.stack ?? err.message}`);
  process.exit(1);
});
