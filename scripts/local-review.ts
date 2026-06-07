#!/usr/bin/env node
/**
 * Local review CLI — runs the full production orchestrator (scanners + agent)
 * against a local git working copy with no GitHub round-trip.
 *
 *   npm run local-review -- --base main --head HEAD
 *   npm run local-review -- --base origin/main --head feat/my-branch
 *   npm run local-review -- --base abc1234 --head def5678 --output /tmp/review.json
 *
 * The git→FakeOctokit machinery now lives in src/local/* and is shared with the
 * `vor` CLI, dashboard, and MCP server. This script is a thin wrapper that
 * preserves the long-standing flags and `.vor/local-runs/<ts>.json` output the
 * eval workflow depends on, and adds the `--scanner-findings-in-user-prompt`
 * A/B injection on top via the shared content-override seam.
 *
 * Why this exists alongside `vor review`: the eval workflow and AGENTS.md
 * reference this exact entry point + JSON output shape. `vor review` is the
 * user-facing surface; this stays as the eval-oriented harness.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { fileContentAtRef, resolveRef } from '../src/local/git.js';
import { runLocalReview } from '../src/local/review.js';

interface Args {
  base: string;
  head: string;
  workspace: string;
  output: string;
  configPath: string;
  model?: string;
  scannerFindingsInUserPrompt: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const a = (flag: string, def?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    base: a('--base', 'origin/main')!,
    head: a('--head', 'HEAD')!,
    workspace: a('--workspace', process.cwd())!,
    output: a('--output', `.vor/local-runs/${ts}.json`)!,
    configPath: a('--config', '.vor.yml')!,
    scannerFindingsInUserPrompt: argv.includes('--scanner-findings-in-user-prompt'),
    ...(a('--model') !== undefined ? { model: a('--model') } : {}),
  };
}

/**
 * Deep-merge `experimental.scanner_findings_in_user_prompt: true` into the
 * repo's existing `.vor.yml` content rather than emitting a minimal YAML that
 * masks it. `existingYaml` may be null (no committed config), in which case the
 * output contains only the experimental key.
 */
function mergeScannerFindingsFlag(existingYaml: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (existingYaml && existingYaml.trim().length > 0) {
    try {
      const raw = parseYaml(existingYaml);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      // Malformed existing YAML — fall back to empty. The orchestrator's config
      // loader surfaces the parse failure on its own when it reads the output.
    }
  }
  const existing = parsed['experimental'];
  const experimental: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  experimental['scanner_findings_in_user_prompt'] = true;
  parsed['experimental'] = experimental;
  return stringifyYaml(parsed);
}

/** Count top-level keys in a YAML document for log-line context. Returns 0 when
 *  parsing fails — purely informational. */
function countTopLevelKeys(yaml: string): number {
  try {
    const raw = parseYaml(yaml);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.keys(raw).length;
    }
  } catch {
    /* swallow */
  }
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';

  if (!anthropicKey && !openaiKey) {
    console.error('ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in the environment.');
    process.exit(2);
  }

  // Build the content-override map. Today: only the experimental flag for
  // scanner-findings-in-user-prompt. We MERGE into the repo's real `.vor.yml`
  // rather than emit a minimal stub — otherwise the A/B run would also flip
  // every unrelated setting back to defaults and the comparison would no longer
  // isolate this flag. Codex P2 #3311267562 on PR #36.
  const contentOverrides = new Map<string, string>();
  if (args.scannerFindingsInUserPrompt) {
    const headSha = resolveRef(args.workspace, args.head);
    const existingYaml = fileContentAtRef(args.workspace, headSha, args.configPath);
    contentOverrides.set(args.configPath, mergeScannerFindingsFlag(existingYaml));
    console.error(
      `local-review: injecting scanner_findings_in_user_prompt=true via merged ${args.configPath}` +
        (existingYaml
          ? ` (preserving ${countTopLevelKeys(existingYaml)} existing top-level key(s))`
          : ''),
    );
  }

  const record = await runLocalReview(
    {
      workspace: args.workspace,
      target: 'range',
      base: args.base,
      head: args.head,
      configPath: args.configPath,
      anthropicApiKey: anthropicKey,
      openaiApiKey: openaiKey,
      ...(args.model !== undefined ? { model: args.model } : {}),
    },
    { contentOverrides },
  );

  console.error(
    `local-review: ${record.base.ref} (${record.base.sha?.slice(0, 7)}) → ` +
      `${record.head.ref} (${record.head.sha?.slice(0, 7)}), ` +
      `${record.files} file(s), +${record.additions}/-${record.deletions}, workspace=${args.workspace}`,
  );

  // Preserve the historical summary shape the eval workflow reads.
  const outPath = resolve(args.workspace, args.output);
  mkdirSync(dirname(outPath), { recursive: true });
  const summary = {
    timestamp: record.timestamp,
    base: record.base,
    head: record.head,
    files: record.files,
    additions: record.additions,
    deletions: record.deletions,
    workspace: record.workspace,
    config_path: record.config_path,
    result: record.result,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.error(`\nReport: ${outPath}`);
  console.error(
    `Result: ended=${record.result.ended}, comments=${record.result.comment_count}, ` +
      `turns=${record.result.turns}, cost=$${record.result.cost_usd.toFixed(4)}`,
  );
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
