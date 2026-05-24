/**
 * Resolve a user-supplied `--case <id>` to an absolute directory inside the
 * golden repo's `cases/` tree, refusing path-traversal escapes.
 *
 * Why this lives in its own module: `scripts/plant.ts` runs `main()` at
 * import time (the existing convention across scripts/golden/*), so tests
 * can't import a helper directly out of plant.ts without triggering the
 * CLI. Splitting `resolveCaseDir` here keeps it unit-testable.
 *
 * `runPlants` performs destructive `rmSync(afterDir, { recursive: true, force: true })`,
 * so a mistyped or malicious case id (e.g. `../../tmp/x`) must NOT be
 * allowed to escape the golden tree. Mirrors the guard in
 * scripts/golden/eval.ts. See PR #10 Codex P2 3294995647.
 */
import { resolve, sep } from 'node:path';

export function resolveCaseDir(goldenRepo: string, caseId: string): string {
  const casesRoot = resolve(goldenRepo, 'cases');
  const caseDir = resolve(casesRoot, caseId);
  if (caseDir === casesRoot) {
    throw new Error('--case must name a specific case directory, not the cases/ root itself.');
  }
  if (!caseDir.startsWith(casesRoot + sep)) {
    throw new Error(
      `--case "${caseId}" resolves outside cases root (${caseDir}) — refusing to proceed.`,
    );
  }
  return caseDir;
}
