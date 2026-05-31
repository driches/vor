/**
 * SAST scanner — runs language-appropriate linters in parallel against the
 * PR's changed files and emits one ScanFinding per relevant violation.
 *
 * Why this exists: pre-v0.4.0 every "this is unused", "missing return type",
 * "no-explicit-any", "deprecated dart API" finding cost a multi-turn Sonnet
 * investigation (~$0.05-0.20 per finding once you account for the growing
 * cache pool). Linters catch these deterministically in seconds at zero
 * token cost. Sonnet should be spending its budget on semantic and design
 * judgment, not re-deriving what ESLint/ruff/dart-analyze/actionlint
 * produce for free.
 *
 * Architecture: this module is a fan-out orchestrator. Each language has
 * its own {@link LinterModule} under `./sast/` that knows how to spawn the
 * appropriate linter, parse its output format, and produce findings
 * restricted to lines this PR actually added. The orchestrator:
 *   1. Asks each module's `applies()` whether the changed-file set has any
 *      files in its scope.
 *   2. For each applicable module, filters changedFiles to its scope and
 *      hands them to `run()`.
 *   3. Runs all applicable modules in parallel.
 *   4. Concatenates findings and errors, sums files_examined.
 *
 * Failure mode: scanner MUST NOT throw. A linter binary missing in the
 * workspace → empty result from that module (not an error — many repos
 * don't have every tool installed). A linter that throws inside its run
 * → its error surfaces as a non-fatal ScanError; other linters still run.
 *
 * Adding a new language: write one module under `./sast/` exporting a
 * LinterModule, and add it to the LINTERS array below.
 */
import type { Scanner, ScannerDeps, ScanResult, ScanError, ScanFinding } from './types.js';
import type { ChangedFile, ScannerId } from '../types.js';
import { emptyResult } from './types.js';
import { eslintLinter } from './sast/eslint.js';
import { ruffLinter } from './sast/ruff.js';
import { dartLinter } from './sast/dart.js';
import { actionlintLinter } from './sast/actionlint.js';
import { knipLinter } from './sast/knip.js';
import { semgrepLinter } from './sast/semgrep.js';
import { tscLinter } from './sast/tsc.js';
import { golangLinter } from './sast/golang.js';
import type { LinterModule } from './sast/linter.js';

const SCANNER_ID: ScannerId = 'sast';

/**
 * Registered linters. Order doesn't affect output (runs are parallel) but
 * is kept stable for log readability and rule_id determinism.
 */
const LINTERS: readonly LinterModule[] = [
  eslintLinter,
  ruffLinter,
  dartLinter,
  actionlintLinter,
  knipLinter,
  semgrepLinter,
  tscLinter,
  golangLinter,
];

/**
 * Extended timeout because the bundled semgrep linter runs `--config=auto`,
 * which downloads its ruleset on first invocation and then scans across
 * every detected language. On a sizable monorepo that easily exceeds the
 * 60s runner default and would otherwise be aborted before producing
 * findings — see semgrep.ts TIMEOUT_MS for the linter-internal cap.
 *
 * MUST be strictly larger than the longest per-linter TIMEOUT_MS
 * (semgrep, 180_000). Pre-fix this was set equal to semgrep's internal
 * cap; the outer scanner-level timer can fire FIRST in a race, killing
 * the whole sast run and discarding the already-collected findings
 * from eslint/ruff/dart/actionlint/knip — breaking per-linter failure
 * isolation. Buffer of 60s lets semgrep cleanly hit its own timer
 * (which kills the child + rejects, surfacing as a non-fatal ScanError
 * for just semgrep) while preserving the other linters' results.
 */
const SAST_TIMEOUT_MS = 240_000;

export function createSastScanner(): Scanner {
  return {
    id: SCANNER_ID,
    timeoutMs: SAST_TIMEOUT_MS,
    applies(files: readonly ChangedFile[]): boolean {
      return LINTERS.some((l) => l.applies(files));
    },
    scan: orchestrate,
  };
}

/**
 * Back-compat export — the registry imports this name. v0.3.x had a stub
 * with the same identifier; replacing it keeps the registry import path
 * stable across the architectural shift.
 */
export const sastScannerStub: Scanner = createSastScanner();

async function orchestrate(deps: ScannerDeps): Promise<ScanResult> {
  const startTime = Date.now();
  // Pre-filter once: removed files don't exist in the checked-out HEAD
  // and shouldn't influence linter activation or selection. Both the
  // applicable check and the per-linter target filter below operate on
  // this set, so a PR that only DELETES TS/JS files won't trigger any
  // linter — including knip, which ignores the file list and always
  // does whole-project analysis (no point in spending its budget when
  // no reviewable findings can result).
  const liveFiles = deps.changedFiles.filter((f) => f.status !== 'removed');
  const applicable = LINTERS.filter((l) => l.applies(liveFiles));
  if (applicable.length === 0) {
    return emptyResult(SCANNER_ID, Date.now() - startTime);
  }

  // For each applicable linter, filter to JUST its scope (so ESLint isn't
  // invoked on .py files, ruff isn't invoked on .ts files, etc.). The
  // per-linter `applies()` is the predicate.
  //
  // Exception: whole-project linters (knip today; potentially more
  // TypeScript-project-wide tools in future) don't take a file argv and
  // use the targetFiles map for output-to-PR-file attribution. They get
  // the full liveFiles set; otherwise a finding for a file outside the
  // linter's normal extension scope would silently drop. The
  // `wholeProject` field on LinterModule replaces the previous hardcoded
  // `linter.id === 'knip'` check so adding a new whole-project linter is
  // a one-line opt-in instead of an orchestrator edit.
  const runs = await Promise.allSettled(
    applicable.map((linter) =>
      linter.run(
        deps,
        linter.wholeProject === true ? liveFiles : liveFiles.filter((f) => linter.applies([f])),
      ),
    ),
  );

  const findings: ScanFinding[] = [];
  const errors: ScanError[] = [];
  let filesExamined = 0;
  let networkCalls = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const linterId = applicable[i]!.id;
    if (r.status === 'fulfilled') {
      findings.push(...r.value.findings);
      errors.push(...r.value.errors);
      filesExamined += r.value.filesExamined;
      networkCalls += r.value.networkCalls ?? 0;
    } else {
      // A linter module that throws is a contract violation — they're
      // supposed to surface errors via the errors array. We still keep
      // the run alive (other linters' results stand) and record this as
      // a non-fatal ScanError so the operator sees it.
      errors.push({
        message: `sast linter '${linterId}' threw: ${(r.reason as Error).message ?? String(r.reason)}`,
        fatal: false,
      });
    }
  }

  return {
    scanner: SCANNER_ID,
    findings,
    errors,
    metrics: {
      duration_ms: Date.now() - startTime,
      files_examined: filesExamined,
      // Sum of per-linter networkCalls (set by each module ONLY when it
      // actually invoked the network — see LinterRun.networkCalls in
      // linter.ts). Avoids inflating the metric when a linter was
      // applicable but its binary wasn't installed and the module exited
      // early.
      network_calls: networkCalls,
      cache_hits: 0,
    },
  };
}
