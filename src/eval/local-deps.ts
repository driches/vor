/**
 * Offline `ToolDeps` for the golden-dataset eval harness.
 *
 * Mirrors what `fetchPRContext` + `new FileReader(octokit)` produce in the live
 * orchestrator path, but loads everything from a captured case directory:
 *
 *   <caseDir>/
 *     meta.yml        case metadata (case_id, owner, repo, pull_number, sha pair)
 *     pr.json         { data: <octokit.pulls.get response data> }
 *     files.json      { data: <octokit.pulls.listFiles response array> }
 *     diff.patch      raw unified diff text
 *     repo/           shallow git clone with base + head SHAs reachable
 *
 * The returned `ToolDeps.fileReader` serves `read()` via `git show <sha>:<path>`
 * against `<caseDir>/repo/`, which means `read_file_at_ref` works for both head
 * and base SHAs. `workspaceDir` also points at the clone, so `grep_repo_at_ref`
 * (which spawns `git grep` in cwd) works against a real `.git` directory.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { loadConfigFromString } from '../config/loader.js';
import type { ReviewConfig } from '../config/types.js';
import { parseUnifiedDiff } from '../github/diff-parser.js';
import type { FileReadRef, FileReader } from '../github/file-reader.js';
import type { PRContext, PRMetadata } from '../github/pr-context.js';
import { ReviewAggregator } from '../output/aggregator.js';
import { createRunContext } from '../agent/run-context.js';
import type { RepoContextEntry } from '../agent/system-prompt.js';
import type { ToolDeps } from '../tools/types.js';
import type { ChangedFile } from '../types.js';

export interface CaseMeta {
  case_id: string;
  pr_url: string;
  owner: string;
  repo: string;
  pull_number: number;
  base_sha: string;
  head_sha: string;
  captured_at: string;
}

export interface BuildLocalDepsInput {
  caseDir: string;
  /** Override the config that would otherwise be loaded from the snapshot. */
  config?: ReviewConfig;
}

export interface BuildLocalDepsResult {
  deps: ToolDeps;
  meta: CaseMeta;
  configSource: 'snapshot' | 'default' | 'override';
}

export async function buildLocalDeps(input: BuildLocalDepsInput): Promise<BuildLocalDepsResult> {
  const caseDir = input.caseDir;
  const meta = await readCaseMeta(caseDir);
  const prContext = await loadPRContext(caseDir, meta);
  const fileReader = new LocalFileReader(resolve(caseDir, 'repo'));

  let config: ReviewConfig;
  let configSource: 'snapshot' | 'default' | 'override';
  if (input.config) {
    config = input.config;
    configSource = 'override';
  } else {
    const snapshotYaml = await fileReader.read({
      owner: meta.owner,
      repo: meta.repo,
      path: '.vor.yml',
      ref: meta.head_sha,
    });
    if (snapshotYaml) {
      config = loadConfigFromString(snapshotYaml);
      configSource = 'snapshot';
    } else {
      config = DEFAULT_CONFIG;
      configSource = 'default';
    }
  }

  const deps: ToolDeps = {
    octokit: {} as Octokit,
    owner: meta.owner,
    repo: meta.repo,
    pull_number: meta.pull_number,
    prContext,
    fileReader: fileReader as unknown as FileReader,
    aggregator: new ReviewAggregator(),
    config,
    workspaceDir: resolve(caseDir, 'repo'),
    runContext: createRunContext(),
  };

  return { deps, meta, configSource };
}

/**
 * Ensure `<caseDir>/repo/` is a usable git checkout at the case's head SHA.
 *
 * Cases captured by the GitHub Action are committed to the private dataset
 * repo WITHOUT the source-code snapshot (gitignored — the per-case
 * `repo/` directory is excluded from version control). When you pull the
 * dataset locally, the snapshot is missing. This function detects that and
 * re-clones the source repo at the captured head SHA so `LocalFileReader`
 * and `grep_repo_at_ref` work.
 *
 * Idempotent: returns immediately if the snapshot already exists.
 * Requires a GitHub token (param > GH_TOKEN > GITHUB_TOKEN) when cloning.
 */
export async function ensureRepoSnapshot(opts: {
  caseDir: string;
  token?: string;
}): Promise<void> {
  const meta = await readCaseMeta(opts.caseDir);
  const repoDir = resolve(opts.caseDir, 'repo');
  if (existsSync(resolve(repoDir, '.git'))) return;

  const token = opts.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    const msg =
      'Snapshot missing at ' +
      repoDir +
      ' and no GH_TOKEN / GITHUB_TOKEN set. Export a token from gh CLI or manually clone ' +
      meta.owner +
      '/' +
      meta.repo +
      ' into that directory at SHA ' +
      meta.head_sha +
      '.';
    throw new Error(msg);
  }

  cloneRepoAtSha({
    owner: meta.owner,
    repo: meta.repo,
    headSha: meta.head_sha,
    dest: repoDir,
    token,
  });
}

/**
 * Shallow-clone a GitHub repo at a specific SHA into `dest`, authenticating
 * via a token that NEVER appears in `argv` (so it can't be observed via
 * `ps`/`/proc/<pid>/cmdline`). Auth is supplied through the `GIT_CONFIG_*`
 * env vars `git` reads at startup — same mechanism `actions/checkout` uses.
 *
 * Used by both `scripts/golden/capture.ts` and `ensureRepoSnapshot` above.
 *
 * Throws on any git step failure. After this returns, `dest/.git` exists,
 * HEAD is detached at `headSha`, and the remote URL is the public
 * non-credentialed form — the token is GC'd with the env object.
 */
export function cloneRepoAtSha(opts: {
  owner: string;
  repo: string;
  headSha: string;
  dest: string;
  token: string;
}): void {
  const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
  const authHeader = `AUTHORIZATION: bearer ${opts.token}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://github.com/.extraheader`,
    GIT_CONFIG_VALUE_0: authHeader,
  };

  const cloneRes = spawnSync(
    'git',
    ['clone', '--depth', '100', '--no-tags', url, opts.dest],
    { stdio: 'inherit', env },
  );
  if (cloneRes.status !== 0) {
    throw new Error(
      `git clone of ${opts.owner}/${opts.repo} failed (exit ${cloneRes.status ?? 'spawn-error'}).`,
    );
  }

  // Try checkout first (works when --depth covers the SHA). Fall back to
  // a SHA-targeted fetch + retry for SHAs older than --depth.
  const co1 = spawnSync('git', ['checkout', '--detach', opts.headSha], {
    cwd: opts.dest,
    stdio: 'inherit',
    env,
  });
  if (co1.status !== 0) {
    const fetch = spawnSync(
      'git',
      ['fetch', '--depth', '100', 'origin', opts.headSha],
      { cwd: opts.dest, stdio: 'inherit', env },
    );
    if (fetch.status !== 0) {
      throw new Error(`git fetch ${opts.headSha} failed in ${opts.dest}.`);
    }
    const co2 = spawnSync('git', ['checkout', '--detach', opts.headSha], {
      cwd: opts.dest,
      stdio: 'inherit',
      env,
    });
    if (co2.status !== 0) {
      throw new Error(`git checkout ${opts.headSha} failed in ${opts.dest}.`);
    }
  }
  // No remote URL cleanup needed: the URL we passed is already public, and
  // the token lives only in the spawned process's env (not in .git/config).
}

/**
 * Read the whitelisted repo context files from the snapshot, exactly like
 * `loadRepoContextFiles` in the orchestrator — used to build the system prompt
 * for the eval run.
 */
export async function loadContextFilesForCase(
  deps: ToolDeps,
  files: readonly string[],
): Promise<RepoContextEntry[]> {
  const entries: RepoContextEntry[] = [];
  const headSha = deps.prContext.metadata.head_sha;
  for (const file of files) {
    const content = await deps.fileReader.read({
      owner: deps.owner,
      repo: deps.repo,
      path: file,
      ref: headSha,
    });
    if (content != null) {
      entries.push({ file, content });
    }
  }
  return entries;
}

async function readCaseMeta(caseDir: string): Promise<CaseMeta> {
  const text = await readFile(resolve(caseDir, 'meta.yml'), 'utf-8');
  const parsed = parseYaml(text) as Partial<CaseMeta> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`meta.yml in ${caseDir} is empty or invalid`);
  }
  const required: Array<keyof CaseMeta> = [
    'case_id',
    'owner',
    'repo',
    'pull_number',
    'base_sha',
    'head_sha',
  ];
  for (const key of required) {
    if (parsed[key] === undefined || parsed[key] === null || parsed[key] === '') {
      throw new Error(`meta.yml in ${caseDir} is missing required field: ${key}`);
    }
  }
  return {
    case_id: String(parsed.case_id),
    pr_url: String(parsed.pr_url ?? ''),
    owner: String(parsed.owner),
    repo: String(parsed.repo),
    pull_number: Number(parsed.pull_number),
    base_sha: String(parsed.base_sha),
    head_sha: String(parsed.head_sha),
    captured_at: String(parsed.captured_at ?? ''),
  };
}

interface PullsGetData {
  title?: string;
  body?: string | null;
  user?: { login?: string };
  base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string };
  labels?: Array<{ name?: string }>;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  draft?: boolean;
}

interface ListFilesEntry {
  filename: string;
  changes?: number;
  patch?: string | null;
}

async function loadPRContext(caseDir: string, meta: CaseMeta): Promise<PRContext> {
  const prData = await readJson<{ data: PullsGetData }>(resolve(caseDir, 'pr.json'));
  const filesData = await readJson<{ data: ListFilesEntry[] }>(resolve(caseDir, 'files.json'));
  const diff = await readFile(resolve(caseDir, 'diff.patch'), 'utf-8');

  const metadata: PRMetadata = {
    number: meta.pull_number,
    title: prData.data.title ?? '',
    body: prData.data.body ?? '',
    author: prData.data.user?.login ?? 'unknown',
    base_sha: meta.base_sha,
    head_sha: meta.head_sha,
    base_ref: prData.data.base?.ref ?? 'unknown',
    head_ref: prData.data.head?.ref ?? 'unknown',
    labels: (prData.data.labels ?? [])
      .map((l) => l.name)
      .filter((n): n is string => typeof n === 'string'),
    changed_file_count: prData.data.changed_files ?? 0,
    additions: prData.data.additions ?? 0,
    deletions: prData.data.deletions ?? 0,
    draft: Boolean(prData.data.draft),
  };

  // Replicate src/github/pr-context.ts:75-83 — merge parsed-diff ChangedFiles
  // with the listFiles API result so `size_bytes` and `is_binary` match a
  // live run. (parse-diff alone marks binaries imperfectly; the API's null
  // `patch` field is the canonical signal.)
  const filesFromDiff = parseUnifiedDiff(diff);
  const filesByPath = new Map<string, { changes: number; patch: string | null }>();
  for (const f of filesData.data) {
    filesByPath.set(f.filename, {
      changes: f.changes ?? 0,
      patch: f.patch == null ? null : f.patch,
    });
  }
  const files: ChangedFile[] = filesFromDiff.map((f) => {
    const apiFile = filesByPath.get(f.path);
    if (!apiFile) return f;
    return {
      ...f,
      size_bytes: apiFile.changes,
      is_binary: f.is_binary || apiFile.patch == null,
    };
  });

  return { metadata, files, diff };
}

async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf-8');
  return JSON.parse(text) as T;
}

/**
 * Reads files from a local git checkout via `git show <ref>:<path>`. Mirrors
 * `FileReader.read` / `readRange` semantics, including returning `null` when
 * the path does not exist at that ref.
 */
class LocalFileReader {
  private cache = new Map<string, string | null>();

  constructor(private readonly repoDir: string) {}

  async read(ref: FileReadRef): Promise<string | null> {
    const key = `${ref.ref}:${ref.path}`;
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }
    const content = await runGitShow(this.repoDir, ref.ref, ref.path);
    this.cache.set(key, content);
    return content;
  }

  async readRange(
    ref: FileReadRef,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; total_lines: number; returned_range: [number, number] } | null> {
    const full = await this.read(ref);
    if (full == null) return null;
    const lines = full.split('\n');
    const total = lines.length;
    const start = Math.max(1, startLine);
    const end = Math.min(total, endLine);
    const slice = lines.slice(start - 1, end).join('\n');
    return { content: slice, total_lines: total, returned_range: [start, end] };
  }
}

function runGitShow(cwd: string, ref: string, path: string): Promise<string | null> {
  return new Promise((res, rej) => {
    const child = spawn('git', ['show', `${ref}:${path}`], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf-8');
    });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) {
        res(stdout);
        return;
      }
      // Mirror FileReader: missing path / bad ref → null, not an error.
      if (
        /does not exist|exists on disk, but not in|unknown revision|bad revision|fatal: path/i.test(
          stderr,
        )
      ) {
        res(null);
        return;
      }
      rej(new Error(`git show ${ref}:${path} failed (${code}): ${stderr.trim()}`));
    });
  });
}
