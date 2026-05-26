/**
 * Shared types for per-language linter modules under src/scanners/sast/.
 *
 * Each linter module exports a {@link LinterModule} that the sast scanner
 * fans out to in parallel. The fan-out runs only the linters whose file
 * extensions appear in the PR's changed-file set — a Python-only PR won't
 * spawn ESLint, etc.
 *
 * The contract is deliberately small so adding a new language requires
 * one new file and one entry in the LINTERS table in `../sast.ts`:
 *   1. Implement `applies(files)` cheaply (extension/path test).
 *   2. Implement `run(deps, targetFiles)` to spawn the linter, parse its
 *      output, and emit ScanFindings restricted to lines this PR added.
 *   3. Append the module to the LINTERS array.
 *
 * Failure mode is the same as the outer Scanner contract: a LinterModule
 * MUST NOT throw. Non-fatal errors return via `errors`, and a missing
 * binary returns an empty result quietly (many repos don't have every
 * linter installed in their workspace, that's not a code-review failure).
 */
import type { ChangedFile } from '../../types.js';
import type { ScannerDeps, ScanFinding, ScanError } from '../types.js';

/**
 * Output of one linter's run. The outer sast scanner sums these into a
 * single ScanResult: findings concatenated, errors concatenated, metrics
 * summed across linters.
 */
export interface LinterRun {
  findings: ScanFinding[];
  errors: ScanError[];
  filesExamined: number;
}

export interface LinterModule {
  /**
   * Stable identifier used as a prefix in rule_ids and fingerprints (so
   * a `ruff/E501` finding never collides with an `eslint/no-unused-vars`).
   * Kept short — appears in PR comment bodies and aggregator logs.
   */
  readonly id: string;

  /** Cheap pre-check; sast skips this linter entirely when false. */
  applies(files: readonly ChangedFile[]): boolean;

  /**
   * Spawn the linter, parse its output, and return findings restricted to
   * lines the PR actually added. `targetFiles` is pre-filtered by the
   * sast orchestrator to the files this linter's `applies()` matched.
   */
  run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun>;
}
