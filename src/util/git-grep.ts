/**
 * Shared `git grep` runner over a local checkout. Extracted from the
 * `grep_repo_at_ref` tool so the agent tool and the deterministic
 * blast-radius pre-pass (src/context/blast-radius.ts) share one
 * implementation instead of each spawning git their own way.
 *
 * Searches the working tree at whatever ref is checked out (in CI that's the
 * PR HEAD). Returns structured matches; never throws on "no matches" (git
 * grep's exit code 1) — only on a real spawn/exec failure.
 */

import { spawn } from 'node:child_process';

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  total: number;
  truncated: boolean;
}

export interface GitGrepOptions {
  /** The search pattern. Interpreted as ERE (git grep -E) unless `fixedString`
   *  is set, in which case it's matched literally (git grep -F). */
  pattern: string;
  /** Directory to run git grep in (the checkout root). */
  cwd: string;
  caseSensitive?: boolean;
  /** Match whole words only (git grep -w). */
  wholeWord?: boolean;
  /** Treat `pattern` as a literal fixed string (git grep -F) instead of a
   *  regex. Use this when the pattern is a raw identifier that may contain
   *  regex metacharacters — e.g. a JS symbol like `$http` or `foo$`, where
   *  `$` under `-E` would be an end-of-line anchor and match nothing. */
  fixedString?: boolean;
  /** Path glob to restrict the search, e.g. "src/**​/*.ts". */
  pathGlob?: string;
  /** Cap on returned matches. */
  maxResults: number;
  /** Spawn timeout. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runGitGrep(opts: GitGrepOptions): Promise<GrepResult> {
  // -F and -E are mutually exclusive; pick one. Fixed-string mode is for raw
  // identifiers that may carry regex metacharacters (see `fixedString`).
  const args = ['grep', '-n', opts.fixedString ? '-F' : '-E'];
  if (!(opts.caseSensitive ?? true)) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  // Limit lines per file is not directly supported; cap globally below.
  args.push('--no-color', '--');
  args.push(opts.pattern);
  if (opts.pathGlob) args.push(opts.pathGlob);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`git grep timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf-8');
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // git grep returns 1 when no matches; that's not an error
      if (code !== 0 && code !== 1) {
        reject(new Error(`git grep exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(parseGrepOutput(stdout, opts.maxResults));
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function parseGrepOutput(out: string, cap: number): GrepResult {
  const lines = out.split('\n').filter((l) => l.length > 0);
  const matches: GrepMatch[] = [];
  for (const line of lines) {
    // Format: "path:line:text"
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({
      path: m[1]!,
      line: Number.parseInt(m[2]!, 10),
      text: m[3]!,
    });
    if (matches.length >= cap) break;
  }
  return {
    matches,
    total: lines.length,
    truncated: lines.length > cap,
  };
}
