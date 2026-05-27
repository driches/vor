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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hard refuse to run if `targetPath` points at, or inside, the public-repo
 * checkout that ships this script. Throws with a clear message rather than
 * returning a boolean so callers can't accidentally ignore the result.
 *
 * Catches both `<repo>/sub/...` (startsWith check) and the exact-equal
 * case `<repo>` === `<targetPath>` (which a plain startsWith with trailing
 * slash would miss).
 *
 * The repo root is anchored to THIS MODULE's location (`import.meta.url`),
 * not `process.cwd()`. The CLI gets invoked from any directory —
 * `cd /tmp && npx tsx /path/to/repo/scripts/eval/synthetic-real.ts ...`
 * is a perfectly normal usage pattern, and cwd-anchored discovery would
 * either find the wrong repo or no repo at all, allowing a user-supplied
 * `--output` under the public checkout despite the guarantee.
 * Codex P2 #3311679449.
 */
export function assertOutsidePublicRepo(targetPath: string, label = 'path'): void {
  const repoRoot = findScriptRepoRoot();
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

/**
 * Walk up from this module's filesystem location to find the nearest `.git`
 * entry. Cached so repeated calls within a process don't restat the path.
 */
let cachedRepoRoot: string | null | undefined;
function findScriptRepoRoot(): string | null {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 16; i++) {
    // `.git` is normally a directory, but in a git worktree it's a file
    // pointing at the main checkout's gitdir. `existsSync` handles both.
    if (existsSync(resolve(dir, '.git'))) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  cachedRepoRoot = null;
  return null;
}
