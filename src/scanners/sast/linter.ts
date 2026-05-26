import path from 'node:path';

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
  /**
   * How many logical network operations this linter actually initiated.
   * Most linters are local-only and leave this 0 (or undefined). semgrep
   * sets it to 1 when its CLI ran successfully — `--config=auto` fetches
   * the ruleset from semgrep.dev. The orchestrator sums these for the
   * scanner-level `network_calls` metric, which feeds cost/security
   * telemetry and matters for air-gapped/strict-egress operators.
   *
   * Important: only set this AFTER the linter actually invoked the
   * network (e.g. set in the success path of runCli, not in `applies()`).
   * Counting based on applicability inflates the metric for repos where
   * the binary is missing.
   */
  networkCalls?: number;
}

/**
 * Normalize a path emitted by an external linter into the repo-relative
 * form `changedFiles` is keyed by.
 *
 * Different linters report paths differently:
 *   - ESLint and `dart analyze --format=machine` emit ABSOLUTE paths.
 *   - Ruff (--output-format=json), Knip (--reporter json), Semgrep
 *     (--json), and actionlint (-format '{{json .}}') emit
 *     REPO-RELATIVE paths.
 *
 * Pre-fix, this module unconditionally called `path.relative(workspaceDir,
 * toolPath)` to map back to `changedFiles` keys. That works for absolute
 * inputs but mangles relative inputs into '../../...' strings that never
 * match — and the failure mode is silent (every finding gets dropped at
 * the `changedFiles.find(...)` step). The fix is to detect the input
 * shape: re-relativize when absolute, pass through when relative.
 *
 * Exported so each linter module can use one consistent normalizer
 * instead of re-deriving the same logic and re-introducing the same bug.
 */
export function normalizeToolPath(workspaceDir: string, toolPath: string): string {
  const normalized = path.isAbsolute(toolPath)
    ? path.relative(workspaceDir, toolPath)
    : path.normalize(toolPath);
  // ALWAYS return POSIX-style forward-slash separators. `changedFiles`
  // is keyed by paths that come out of `git diff`, which uses '/'
  // regardless of platform. `path.relative` and `path.normalize` use
  // OS-native separators — on Windows they'd return `src\\foo.ts`, the
  // `===` lookup would miss every time, and EVERY sast finding would
  // be silently dropped on Windows runners. Convert here so the helper
  // is the single source of truth for path shape.
  return normalized.split(path.sep).join('/');
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
