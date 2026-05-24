/**
 * Resolve a user-supplied `--case <id>` to an absolute directory inside the
 * golden repo's `cases/` tree, refusing path-traversal escapes (lexical
 * `..`-style and also symlink-based escapes).
 *
 * Why this lives in its own module: `scripts/plant.ts` runs `main()` at
 * import time (the existing convention across scripts/golden/*), so tests
 * can't import a helper directly out of plant.ts without triggering the
 * CLI. Splitting `resolveCaseDir` here keeps it unit-testable.
 *
 * `runPlants` performs destructive `rmSync(afterDir, { recursive: true, force: true })`,
 * so a mistyped or malicious case id (e.g. `../../tmp/x`) must NOT be
 * allowed to escape the golden tree. Mirrors the guard in
 * scripts/golden/eval.ts. See PR #10 Codex P2 3294995647 (lexical case)
 * and PR #10 Codex P1 3295120950 (symlink case).
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function resolveCaseDir(goldenRepo: string, caseId: string): string {
  const casesRoot = resolve(goldenRepo, 'cases');
  const caseDir = resolve(casesRoot, caseId);
  // Lexical check first: catches `../`-style escapes and the cases-root-itself
  // case cheaply, without touching the filesystem.
  if (caseDir === casesRoot) {
    throw new Error('--case must name a specific case directory, not the cases/ root itself.');
  }
  if (!caseDir.startsWith(casesRoot + sep)) {
    throw new Error(
      `--case "${caseId}" resolves outside cases root (${caseDir}) — refusing to proceed.`,
    );
  }
  // Symlink check: realpath both ends and re-verify the prefix. A
  // `cases/<id>` symlink pointing at `/tmp/outside` would pass the lexical
  // check above, then runPlants's destructive `rmSync(afterDir, { recursive: true, force: true })`
  // would follow the symlink and delete `/tmp/outside/after`. Canonicalize
  // both sides so symlink-based escapes are rejected too.
  //
  // Only canonicalize when both paths exist on disk — if the case dir is
  // missing, runPlants throws its own "missing plants.yml" error with a
  // clearer message. realpathSync throws ENOENT on missing paths, so
  // gating on existsSync keeps the "case not found" path producing the
  // better error from runPlants.
  if (existsSync(casesRoot) && existsSync(caseDir)) {
    const realCasesRoot = realpathSync(casesRoot);
    const realCaseDir = realpathSync(caseDir);
    if (realCaseDir === realCasesRoot) {
      throw new Error(
        `--case "${caseId}" resolves (via symlink) to the cases root itself (${realCasesRoot}) — refusing to proceed.`,
      );
    }
    if (!realCaseDir.startsWith(realCasesRoot + sep)) {
      throw new Error(
        `--case "${caseId}" resolves (via symlink) outside cases root: ${realCaseDir} ↛ ${realCasesRoot} — refusing to proceed.`,
      );
    }
  }
  return caseDir;
}
