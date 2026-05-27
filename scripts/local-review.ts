#!/usr/bin/env node
/**
 * Local review CLI — runs the full production orchestrator (scanners + agent)
 * against a local git working copy with no GitHub round-trip.
 *
 *   npm run local-review -- --base main --head HEAD
 *   npm run local-review -- --base origin/main --head feat/my-branch
 *   npm run local-review -- --base abc1234 --head def5678 --output /tmp/review.json
 *
 * Uses git locally to enumerate changed files and read content at each ref.
 * Constructs a FakeOctokit that satisfies the Octokit interface surface the
 * orchestrator + scanners + agent tools actually use, sourced from git. Runs
 * `runOrchestrator(...)` with `dry_run: true` so nothing posts — the review
 * gets logged to stdout and the full structured result saved to JSON.
 *
 * Why this exists: the golden eval harness uses synthesized PR content and a
 * /tmp/eval workspace where linter binaries don't exist, so it measures
 * agent-only behavior. Production runs require pushing a PR and waiting on
 * GitHub Actions. This CLI fills the gap — real scanners against the real
 * workspace (where binaries exist), real LLM, no GitHub.
 */

import type { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runOrchestrator } from '../src/orchestrator.js';

interface Args {
  base: string;
  head: string;
  workspace: string;
  output: string;
  configPath: string;
  model?: string;
  /**
   * When true, the FakeOctokit's `repos.getContent` for `.code-review.yml`
   * returns a synthetic YAML overriding `experimental.scanner_findings_in_user_prompt`
   * to `true` instead of whatever's at HEAD. Lets you A/B the flag without
   * committing config changes. The override is shallow — any other keys at
   * HEAD's `.code-review.yml` are ignored.
   */
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
    output: a('--output', `.code-review/local-runs/${ts}.json`)!,
    configPath: a('--config', '.code-review.yml')!,
    scannerFindingsInUserPrompt: argv.includes('--scanner-findings-in-user-prompt'),
    ...(a('--model') !== undefined ? { model: a('--model') } : {}),
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024, // 256 MB — large diffs / file contents
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveRef(workspace: string, ref: string): string {
  return git(['rev-parse', ref], workspace).trim();
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  previous_path?: string;
}

function diffNameStatus(workspace: string, base: string, head: string): ChangedFile[] {
  // --name-status returns one line per file; --numstat appends additions/deletions.
  // Use `git diff --raw` style output combined with numstat for the canonical
  // GitHub API shape. Simpler: two passes.
  const status = git(['diff', '--name-status', `${base}..${head}`], workspace);
  const numstat = git(['diff', '--numstat', `${base}..${head}`], workspace);

  const stats = new Map<string, { add: number; del: number }>();
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    const add = m[1] === '-' ? 0 : Number.parseInt(m[1]!, 10);
    const del = m[2] === '-' ? 0 : Number.parseInt(m[2]!, 10);
    stats.set(m[3]!, { add, del });
  }

  const files: ChangedFile[] = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]!;
    if (code.startsWith('A')) {
      const p = parts[1]!;
      const s = stats.get(p) ?? { add: 0, del: 0 };
      files.push({ path: p, status: 'added', additions: s.add, deletions: s.del });
    } else if (code.startsWith('M')) {
      const p = parts[1]!;
      const s = stats.get(p) ?? { add: 0, del: 0 };
      files.push({ path: p, status: 'modified', additions: s.add, deletions: s.del });
    } else if (code.startsWith('D')) {
      const p = parts[1]!;
      const s = stats.get(p) ?? { add: 0, del: 0 };
      files.push({ path: p, status: 'removed', additions: s.add, deletions: s.del });
    } else if (code.startsWith('R')) {
      const previous = parts[1]!;
      const current = parts[2]!;
      const s = stats.get(current) ?? stats.get(`${previous} => ${current}`) ?? { add: 0, del: 0 };
      files.push({
        path: current,
        status: 'renamed',
        additions: s.add,
        deletions: s.del,
        previous_path: previous,
      });
    }
  }
  return files;
}

function getFileContent(workspace: string, ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`], workspace);
  } catch {
    return null; // file doesn't exist at this ref (added/removed)
  }
}

function unifiedDiff(workspace: string, base: string, head: string): string {
  return git(
    ['diff', '--no-color', '--unified=3', `${base}..${head}`],
    workspace,
  );
}

/**
 * Per-file patch in the GitHub Files API shape. The orchestrator (and
 * pr-context.ts specifically) treats `apiFile.patch == null` as "binary
 * file" and skips it from SAST scanners. Without per-file patches the
 * scanners never see ANY file's contents — they all skip as binary.
 *
 * GitHub's Files API returns just the hunk body without the `--- a/...`
 * `+++ b/...` `diff --git` headers; we strip those here to match.
 */
function perFilePatch(
  workspace: string,
  base: string,
  head: string,
  path: string,
): string | null {
  try {
    const raw = git(
      ['diff', '--no-color', '--unified=3', `${base}..${head}`, '--', path],
      workspace,
    );
    if (!raw.trim()) return null;
    // Drop the `diff --git`, `index`, `---`, `+++` header lines so the
    // remainder matches what GitHub's listFiles `patch` field contains.
    const lines = raw.split('\n');
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    return firstHunk < 0 ? null : lines.slice(firstHunk).join('\n');
  } catch {
    return null;
  }
}

function authorFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%aN', 'HEAD'], workspace).trim();
  } catch {
    return 'local-user';
  }
}

function titleFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%s', 'HEAD'], workspace).trim();
  } catch {
    return 'Local review';
  }
}

function bodyFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%b', 'HEAD'], workspace).trim();
  } catch {
    return '';
  }
}

/**
 * Build a FakeOctokit that satisfies the methods the orchestrator + tools call
 * during a normal (dry-run) review. Anything we don't expect to hit throws
 * loudly so we catch unimplemented surface fast rather than silently returning
 * undefined and getting confusing downstream errors.
 */
function buildFakeOctokit(opts: {
  workspace: string;
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
  diff: string;
  prMeta: {
    title: string;
    body: string;
    author: string;
    additions: number;
    deletions: number;
  };
  /**
   * Path → synthetic content overrides for `repos.getContent`. Used by the
   * CLI to inject a different `.code-review.yml` than the one committed at
   * HEAD, so flags can be A/B tested without git churn.
   */
  contentOverrides: Map<string, string>;
}): Octokit {
  // GitHub's listFiles shape has `filename`, `status`, `additions`, `deletions`,
  // `changes`, `patch` (per-file diff). The orchestrator only needs filename +
  // status + additions/deletions for its accounting. Per-file patch is read
  // separately from the unified diff via the diff fetcher.
  // Critical: include the per-file `patch` field. pr-context.ts treats
  // `apiFile.patch == null` as binary, which makes SAST scanners skip the
  // file entirely (semgrep.applies() filters out is_binary files). Without
  // this, the scanner pipeline produces zero findings even when semgrep's
  // own CLI catches issues in the file.
  const fileApi = opts.files.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    previous_filename: f.previous_path,
    sha: opts.headSha,
    patch: perFilePatch(opts.workspace, opts.baseSha, opts.headSha, f.path),
  }));

  const notImplemented = (method: string) =>
    async (..._args: unknown[]): Promise<never> => {
      throw new Error(
        `local-review FakeOctokit: ${method} is not implemented — extend buildFakeOctokit if a code path requires it.`,
      );
    };

  // Cast through unknown because we're only implementing the surface used; the
  // full Octokit interface has hundreds of methods we don't need.
  return {
    rest: {
      pulls: {
        get: async (args: { mediaType?: { format?: string } }) => {
          if (args.mediaType?.format === 'diff') {
            return { data: opts.diff as unknown };
          }
          return {
            data: {
              number: 0,
              title: opts.prMeta.title,
              body: opts.prMeta.body,
              user: { login: opts.prMeta.author },
              draft: false,
              additions: opts.prMeta.additions,
              deletions: opts.prMeta.deletions,
              changed_files: fileApi.length,
              labels: [],
              head: { sha: opts.headSha, ref: 'local-head' },
              base: { sha: opts.baseSha, ref: 'local-base' },
            },
          };
        },
        listFiles: async () => ({ data: fileApi }),
        // Sticky dismissal lookup: no prior reviews to dismiss.
        listReviews: async () => ({ data: [] }),
        dismissReview: notImplemented('pulls.dismissReview'),
        // Dry-run never reaches createReview, but stub it for safety.
        createReview: async () => ({ data: { id: 0 } }),
      },
      repos: {
        getContent: async (args: { path: string; ref?: string }) => {
          // Honor explicit overrides first — used by the CLI to inject a
          // synthetic `.code-review.yml` without committing config changes.
          const override = opts.contentOverrides.get(args.path);
          const ref = args.ref ?? opts.headSha;
          const content = override ?? getFileContent(opts.workspace, ref, args.path);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';

  if (!anthropicKey && !openaiKey) {
    console.error(
      'ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in the environment.',
    );
    process.exit(2);
  }

  // Resolve refs to SHAs so we have stable identifiers even if the underlying
  // refs move during the run.
  const baseSha = resolveRef(args.workspace, args.base);
  const headSha = resolveRef(args.workspace, args.head);
  if (baseSha === headSha) {
    console.error(`Base and head resolve to the same SHA (${baseSha.slice(0, 7)}). Nothing to review.`);
    process.exit(2);
  }

  const files = diffNameStatus(args.workspace, baseSha, headSha);
  if (files.length === 0) {
    console.error(`No changed files between ${args.base} (${baseSha.slice(0, 7)}) and ${args.head} (${headSha.slice(0, 7)}).`);
    process.exit(2);
  }

  const diff = unifiedDiff(args.workspace, baseSha, headSha);
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  console.error(
    `local-review: ${args.base} (${baseSha.slice(0, 7)}) → ${args.head} (${headSha.slice(0, 7)}), ` +
      `${files.length} file(s), +${totalAdditions}/-${totalDeletions}, workspace=${args.workspace}`,
  );

  // Build the content-override map. Today: only the experimental flag
  // for scanner-findings-in-user-prompt. The override is a minimal YAML
  // snippet — the orchestrator's loadConfig deep-merges it into defaults.
  const contentOverrides = new Map<string, string>();
  if (args.scannerFindingsInUserPrompt) {
    contentOverrides.set(
      args.configPath,
      `experimental:\n  scanner_findings_in_user_prompt: true\n`,
    );
    console.error(
      `local-review: injecting scanner_findings_in_user_prompt=true via synthetic ${args.configPath}`,
    );
  }

  const fakeOctokit = buildFakeOctokit({
    workspace: args.workspace,
    baseSha,
    headSha,
    files,
    diff,
    prMeta: {
      title: titleFromHead(args.workspace),
      body: bodyFromHead(args.workspace),
      author: authorFromHead(args.workspace),
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    contentOverrides,
  });

  const result = await runOrchestrator({
    owner: 'local',
    repo: 'local',
    pull_number: 0,
    anthropic_api_key: anthropicKey,
    openai_api_key: openaiKey,
    // Token is unused by the FakeOctokit but the orchestrator passes it through
    // logger.setSecret(). A non-empty placeholder keeps that contract happy.
    github_token: 'local-review-placeholder-token',
    ...(args.model !== undefined ? { model_override: args.model } : {}),
    config_path: args.configPath,
    dry_run: true,
    workspace_dir: args.workspace,
    octokitFactory: () => fakeOctokit,
  });

  // Save the structured result alongside the runs/ directory.
  const outPath = resolve(args.workspace, args.output);
  mkdirSync(dirname(outPath), { recursive: true });
  const summary = {
    timestamp: new Date().toISOString(),
    base: { ref: args.base, sha: baseSha },
    head: { ref: args.head, sha: headSha },
    files: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    workspace: args.workspace,
    config_path: args.configPath,
    result,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.error(`\nReport: ${outPath}`);
  console.error(
    `Result: ended=${result.ended}, comments=${result.comment_count}, turns=${result.turns}, cost=$${result.cost_usd.toFixed(4)}`,
  );
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
