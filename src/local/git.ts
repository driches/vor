/**
 * Git helpers for local reviews — enumerate changed files, build unified diffs,
 * and read file content at a ref or from the working tree. Extracted from
 * scripts/local-review.ts so the CLI, dashboard, and MCP server share one
 * implementation.
 *
 * Two review shapes are supported by parameterizing the git "range":
 *   - range mode:        diffArgs = ['<base>..<head>']  (two committed refs)
 *   - working-tree mode: diffArgs = ['HEAD']            (HEAD vs uncommitted)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  previous_path?: string;
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024, // 256 MB — large diffs / file contents
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveRef(workspace: string, ref: string): string {
  return git(['rev-parse', ref], workspace).trim();
}

/**
 * Resolve a path inside a repo to the repository top-level. `git diff` reports
 * paths relative to the repo root, so a review launched from a subdirectory must
 * operate from the root or file-content lookups and scanner roots (tsconfig,
 * node_modules) point at the wrong place. Falls back to the input when it isn't
 * a git checkout — downstream git calls then surface the error loudly.
 */
export function repoRoot(workspace: string): string {
  try {
    return git(['rev-parse', '--show-toplevel'], workspace).trim() || workspace;
  } catch {
    return workspace;
  }
}

/**
 * True when the working tree has staged/unstaged changes OR untracked files
 * (respecting .gitignore). Untracked files are included because the canonical
 * pre-push review case is "I just created a file and haven't committed it" —
 * skipping those would silently miss new code and secrets.
 */
export function hasWorkingTreeChanges(workspace: string): boolean {
  const out = git(['status', '--porcelain'], workspace);
  return out.split('\n').some((line) => line.trim().length > 0);
}

/** Untracked, non-ignored files in the working tree (new files not yet added). */
export function untrackedFiles(workspace: string): string[] {
  const out = git(['ls-files', '--others', '--exclude-standard'], workspace);
  return out.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * A new-file patch for an untracked file, synthesized with `git diff --no-index`
 * against /dev/null. This does NOT touch the index (no `git add`), so the user's
 * staging state is untouched. git exits 1 when differences exist; that carries
 * the patch on stdout, which execFileSync surfaces via the thrown error.
 */
function untrackedPatch(workspace: string, path: string): string {
  try {
    return git(['diff', '--no-index', '--no-color', '--', '/dev/null', path], workspace);
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    if (e.status === 1 && e.stdout != null) return e.stdout.toString();
    return ''; // unreadable / binary edge — skip rather than fail the review
  }
}

/**
 * The full working-tree change set: tracked modifications (HEAD vs disk) plus
 * untracked new files, as a combined file list and unified diff. Used by
 * working-tree reviews so `vor review` covers exactly what you'd commit next.
 */
export function workingTreeChanges(workspace: string): { files: ChangedFile[]; diff: string } {
  const files = changedFiles(workspace, ['HEAD']);
  const diffs = [unifiedDiff(workspace, ['HEAD'])];

  for (const path of untrackedFiles(workspace)) {
    const patch = untrackedPatch(workspace, path);
    if (!patch.trim()) continue;
    diffs.push(patch);
    // Count added lines from the patch (binary files yield 0).
    const additions = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    files.push({ path, status: 'added', additions, deletions: 0 });
  }

  return { files, diff: diffs.filter((d) => d.trim().length > 0).join('\n') };
}

/**
 * Parse `git diff --name-status` + `--numstat` for a given range into the
 * canonical ChangedFile shape. `diffArgs` is the range spec appended to the
 * diff invocation (e.g. `['base..head']` or `['HEAD']`).
 */
export function changedFiles(workspace: string, diffArgs: string[]): ChangedFile[] {
  const status = git(['diff', '--name-status', ...diffArgs], workspace);
  const numstat = git(['diff', '--numstat', ...diffArgs], workspace);

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

export function unifiedDiff(workspace: string, diffArgs: string[]): string {
  return git(['diff', '--no-color', '--unified=3', ...diffArgs], workspace);
}

/** File content at a committed ref, or null when the path doesn't exist there. */
export function fileContentAtRef(workspace: string, ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`], workspace);
  } catch {
    return null; // file doesn't exist at this ref (added/removed)
  }
}

/** Whether `target` is `root` or sits strictly inside it (no '..' escape). */
function contains(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** File content from the working tree on disk, or null when it's absent. */
export function fileContentOnDisk(workspace: string, path: string): string | null {
  // The real GitHub Contents API can't read outside the repo; this fake one
  // serves read_file_at_ref for working-tree HEAD, so a model-supplied path
  // like `../../.ssh/id_rsa` must not escape the checkout. Reject anything that
  // resolves outside `workspace` (relative() yields a '..' segment or an
  // absolute path when the target isn't contained).
  const root = resolve(workspace);
  const target = resolve(root, path);
  if (!contains(root, target)) return null;
  // The lexical check above is defeated by a symlink inside the repo that
  // points outside it, since readFileSync would follow it. Resolve the full
  // symlink chain (of both ends, so a repo reached through a symlinked path
  // still matches) and re-confine before reading.
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    return null; // missing path or dangling symlink
  }
  if (!contains(realRoot, realTarget)) return null;
  try {
    return readFileSync(realTarget, 'utf-8');
  } catch {
    return null; // deleted in the working tree, or unreadable
  }
}

export function authorFromHead(workspace: string, ref = 'HEAD'): string {
  try {
    return git(['log', '-1', '--format=%aN', ref], workspace).trim();
  } catch {
    return 'local-user';
  }
}

export function titleFromHead(workspace: string, ref = 'HEAD'): string {
  try {
    return git(['log', '-1', '--format=%s', ref], workspace).trim();
  } catch {
    return 'Local review';
  }
}

export function bodyFromHead(workspace: string, ref = 'HEAD'): string {
  try {
    return git(['log', '-1', '--format=%b', ref], workspace).trim();
  } catch {
    return '';
  }
}

/** SHA currently checked out on disk, or '' when HEAD can't be resolved. */
export function currentHeadSha(workspace: string): string {
  try {
    return resolveRef(workspace, 'HEAD');
  } catch {
    return '';
  }
}

/**
 * Create a detached linked worktree at `sha` so disk-backed scanners and the
 * grep/blast-radius tools run against the requested tree rather than whatever is
 * checked out. A fresh worktree has no installed dependencies, so the main
 * checkout's node_modules is symlinked in (best-effort) — without it the SAST
 * tools (eslint/tsc/…) would silently no-op. Returns the worktree path; pair
 * with removeWorktree() in a finally.
 */
export function addDetachedWorktree(workspace: string, sha: string): string {
  // git worktree add wants a path that doesn't yet exist; mkdtemp gives us a
  // unique parent, and git creates the `tree` child under it.
  const parent = mkdtempSync(join(tmpdir(), 'vor-worktree-'));
  const dir = join(parent, 'tree');
  git(['worktree', 'add', '--detach', '--quiet', dir, sha], workspace);
  try {
    const nm = join(workspace, 'node_modules');
    if (existsSync(nm)) symlinkSync(nm, join(dir, 'node_modules'), 'dir');
  } catch {
    // Best-effort: the agent diff/content are still anchored to the head; only
    // dependency-backed linters degrade to a no-op.
  }
  return dir;
}

/** Remove a worktree created by addDetachedWorktree and its temp parent. */
export function removeWorktree(workspace: string, dir: string): void {
  try {
    git(['worktree', 'remove', '--force', dir], workspace);
  } catch {
    // already gone / git refused — fall through to rm the temp parent
  }
  try {
    rmSync(dirname(dir), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
