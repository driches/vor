/**
 * Privacy guard for paths that hold dataset content.
 *
 * The golden dataset (cases + reports + run JSON) contains snippets from
 * the source PRs being evaluated, which are typically private code. Any
 * eval CLI that writes into `GOLDEN_REPO_PATH` (or any user-supplied
 * `--output`) must verify that path is OUTSIDE this public repo before
 * touching it — otherwise an accidental `GOLDEN_REPO_PATH=.` or `--output
 * ./reports/foo.json` would leak captured review bodies / agent transcripts
 * into the public worktree.
 *
 * `scripts/golden/eval.ts` originally defined this guard inline. The
 * captured-real / synthetic-real harnesses need the same behavior; hoisting
 * it here keeps the rule in one place. Codex P2 #3311625847.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Hard refuse to run if `targetPath` points at, or inside, the current
 * public-repo checkout. Throws with a clear message rather than returning
 * a boolean so callers can't accidentally ignore the result.
 *
 * Catches both `<repo>/sub/...` (startsWith check) and the exact-equal
 * case `<repo>` === `<targetPath>` (which a plain startsWith with trailing
 * slash would miss).
 */
export function assertOutsidePublicRepo(targetPath: string, label = 'path'): void {
  const here = resolve(process.cwd());
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) return;
  const resolved = resolve(targetPath);
  const inside = resolved === repoRoot || resolved.startsWith(repoRoot + '/');
  if (inside) {
    throw new Error(
      `${label} (${resolved}) is inside or equal to this public repo (${repoRoot}). ` +
        `Reports and runs may contain snippets of private code — point ${label} at a separate location.`,
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
