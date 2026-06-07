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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * True when the working tree has staged or unstaged changes to tracked files.
 * Untracked files are ignored — a review needs a diff against HEAD, and a
 * brand-new untracked file has no committed counterpart to diff against. Mirrors
 * what `git diff HEAD` will actually surface.
 */
export function hasWorkingTreeChanges(workspace: string): boolean {
  // --porcelain lines for tracked changes start with a status code in the first
  // two columns; untracked files are reported as '??'. Filter those out.
  const out = git(['status', '--porcelain', '--untracked-files=no'], workspace);
  return out.split('\n').some((line) => line.trim().length > 0);
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

/** File content from the working tree on disk, or null when it's absent. */
export function fileContentOnDisk(workspace: string, path: string): string | null {
  try {
    return readFileSync(join(workspace, path), 'utf-8');
  } catch {
    return null; // deleted in the working tree, or unreadable
  }
}

export function authorFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%aN', 'HEAD'], workspace).trim();
  } catch {
    return 'local-user';
  }
}

export function titleFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%s', 'HEAD'], workspace).trim();
  } catch {
    return 'Local review';
  }
}

export function bodyFromHead(workspace: string): string {
  try {
    return git(['log', '-1', '--format=%b', 'HEAD'], workspace).trim();
  } catch {
    return '';
  }
}
