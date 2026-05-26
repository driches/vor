/**
 * Concrete `Scanner` for flagging PR-added lines that the test suite doesn't
 * exercise.
 *
 * Pipeline per PR:
 *
 *   1. Detect which coverage tool the project uses by inspecting the
 *      workspace. Detection priority (stop at first match):
 *        a. vitest — when `package.json` declares a coverage script or has
 *           vitest as a (dev)dependency AND the PR touches a non-Python file
 *           the tool could exercise.
 *        b. jest — when `package.json` declares a jest config or coverage
 *           script AND vitest wasn't detected.
 *        c. pytest-cov — when `pyproject.toml`/`pytest.ini`/`setup.cfg`/
 *           `conftest.py` exists AND the PR touches a Python file.
 *        d. None → quietly skip (empty result, no error).
 *   2. Spawn the chosen tool with JSON coverage output:
 *        - vitest:    `npx vitest run --coverage --reporter=json`
 *                     (vitest writes JSON to `coverage/coverage-final.json`)
 *        - jest:      `npx jest --coverage --coverageReporters=json
 *                     --coverageDirectory=<workspace>/coverage`
 *        - pytest-cov: `pytest --cov --cov-report=json:<workspace>/coverage.json`
 *   3. Parse `coverage-final.json` (vitest / jest) or `coverage.json`
 *      (pytest-cov). Both flavours encode coverage as a path → { statementMap,
 *      s } map (Istanbul / coverage.py expose compatible shapes via JSON
 *      reporters). A line is "covered" if AT LEAST ONE statement on that
 *      line has hit count > 0.
 *   4. For each PR-added line that maps to an uncovered statement, emit a
 *      `test-gap` finding (severity `minor`, confidence `medium`).
 *
 * Failure isolation: this scanner MUST NOT throw. A missing tool, a failed
 * subprocess, an unparseable JSON, or a missing artifact all degrade to an
 * empty findings list. Test failures themselves are NOT a coverage failure —
 * if the tool exits non-zero but still produced coverage data, we use it.
 *
 * Timeout: 240_000 ms (matches the SAST timeout). Coverage runs can be slow
 * on large suites.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { logger as defaultLogger } from '../util/logger.js';
import type {
  Scanner,
  ScannerDeps,
  ScanResult,
  ScanFinding,
  ScanError,
  ScannerMetrics,
} from './types.js';
import type { ChangedFile, ScannerId } from '../types.js';

const SCANNER_ID: ScannerId = 'coverage-delta';

/** Per-scanner timeout. Coverage runs can be slow on large suites; we match
 *  the outer SAST budget so a single coverage invocation can use the full
 *  per-scanner deadline without being killed early. */
const COVERAGE_TIMEOUT_MS = 240_000;

/** Hard cap on bytes we'll ever read from a coverage JSON file. Coverage
 *  reports can be tens of MB on monorepos; loading the entire thing into a
 *  JSON.parse call would blow runner memory. 50 MB is generous enough to
 *  cover even very large projects in practice. */
const MAX_COVERAGE_JSON_BYTES = 50 * 1024 * 1024;

/** Source-file extensions that vitest / jest can meaningfully cover. Used
 *  to short-circuit JS-coverage detection on Python-only PRs (we don't want
 *  to spawn vitest for a PR that only changes `*.py`). */
const JS_SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Source-file extensions pytest-cov can meaningfully cover. */
const PYTHON_SOURCE_EXTENSION = /\.(py|pyi)$/;

/**
 * Structural type for the logger we accept via DI. Mirrors only the methods
 * this scanner actually calls, so tests can stub without dragging in
 * `@actions/core`.
 */
export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface CoverageDeltaScannerOptions {
  /** Override the logger — primarily a DI hook for tests. */
  logger?: Logger;
  /**
   * Override the tool-detection step. Tests inject a synthetic detection so
   * the scanner can be exercised without manipulating files on disk. When
   * unset, production detection uses {@link detectCoverageTool}.
   */
  detectTool?: (deps: ScannerDeps) => DetectedTool | null;
  /**
   * Override the subprocess runner. Tests stub this to return synthetic
   * coverage JSON without spawning a real tool. Production uses
   * {@link runCoverageCli}.
   */
  runCli?: (
    tool: DetectedTool,
    deps: ScannerDeps,
  ) => Promise<CoverageRunOutcome>;
  /**
   * Override the JSON loader. Tests inject in-memory coverage data so the
   * scanner doesn't have to write fixture files. Production reads
   * `<tool.artifact>` via `readFileSync`.
   */
  loadCoverage?: (tool: DetectedTool, deps: ScannerDeps) => CoverageMap | null;
}

/** Which tool was detected, plus the absolute path of the JSON artifact to
 *  parse after the run. */
export interface DetectedTool {
  id: 'vitest' | 'jest' | 'pytest-cov';
  /** Absolute path inside the workspace where the JSON coverage report
   *  lands. Used by the post-run parsing step. */
  artifact: string;
}

/** Outcome of running the coverage CLI. We deliberately don't distinguish
 *  between "tests passed" and "tests failed" — a non-zero exit from failed
 *  tests is fine as long as coverage data was produced. The CLI runner only
 *  rejects on signals/timeouts/binary-not-found, never on a test-failure
 *  exit code. */
export interface CoverageRunOutcome {
  /** True when the subprocess produced a coverage JSON we can parse. False
   *  when the run was killed, the binary was missing, or the artifact
   *  didn't materialise. */
  ok: boolean;
  /** Human-readable failure reason when `ok === false`. */
  reason?: string;
}

/**
 * Istanbul-compatible coverage shape. Both vitest and jest emit this via the
 * `json` reporter; pytest-cov's `--cov-report=json` is a superset that we
 * normalize at load time.
 */
export type CoverageMap = Record<string, FileCoverage>;

export interface FileCoverage {
  /** Statement id → location. */
  statementMap: Record<string, StatementLocation>;
  /** Statement id → hit count. */
  s: Record<string, number>;
}

export interface StatementLocation {
  start: { line: number; column?: number };
  end: { line: number; column?: number };
}

/**
 * pytest-cov's `coverage json` shape (the one produced by
 * `pytest --cov --cov-report=json`). We translate it to the Istanbul shape
 * during load so the rest of the scanner is tool-agnostic.
 */
interface PythonCoverageReport {
  files: Record<string, PythonCoverageFile>;
}

interface PythonCoverageFile {
  /** Lines actually exercised — covered statements. */
  executed_lines?: number[];
  /** Lines that exist as statements but weren't exercised — uncovered. */
  missing_lines?: number[];
  /** Sometimes coverage.py emits the full statement list separately. */
  summary?: { num_statements?: number };
}

export function createCoverageDeltaScanner(
  options: CoverageDeltaScannerOptions = {},
): Scanner {
  const log = options.logger ?? defaultLogger;
  const detect = options.detectTool ?? detectCoverageTool;
  const run = options.runCli ?? runCoverageCli;
  const load = options.loadCoverage ?? loadCoverageMap;

  return {
    id: SCANNER_ID,
    // Coverage runs can be slow — large test suites routinely take 60-180s.
    // Match the SAST budget so the per-scanner deadline doesn't kill a
    // legitimate run.
    timeoutMs: COVERAGE_TIMEOUT_MS,

    applies(files: readonly ChangedFile[]): boolean {
      // We only meaningfully cover non-binary source files. A PR that only
      // touches binary blobs, docs, or generated bundles can't produce
      // coverage findings on `added_lines`, so don't bother spinning up the
      // tool. We don't restrict to JS/Py here — pytest-cov can cover .pyx
      // and other extensions and a project may have arbitrary tool config.
      // The per-tool detection step refines further.
      for (const f of files) {
        if (!f.is_binary && !f.is_generated && f.added_lines.size > 0) return true;
      }
      return false;
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;

      let tool: DetectedTool | null;
      try {
        tool = detect(deps);
      } catch (err) {
        void log.warn(
          `coverage-delta: tool detection failed: ${(err as Error).message}`,
        );
        return finalize(started, [], errors, 0);
      }
      if (tool === null) {
        void log.debug(
          'coverage-delta: no supported coverage tool detected; skipping',
        );
        return finalize(started, [], errors, 0);
      }

      void log.debug(
        `coverage-delta: detected ${tool.id}; artifact=${tool.artifact}`,
      );

      let outcome: CoverageRunOutcome;
      try {
        outcome = await run(tool, deps);
      } catch (err) {
        // Defensive: runCoverageCli is supposed to surface its own errors via
        // `ok: false`, never throw. If a custom override (or a future change)
        // throws, we still degrade gracefully here rather than letting it
        // crash the scanner pipeline.
        void log.warn(
          `coverage-delta: ${tool.id} runner threw: ${(err as Error).message}`,
        );
        errors.push({
          message: `coverage-delta: ${tool.id} runner failed`,
          cause: (err as Error).message,
          fatal: false,
        });
        return finalize(started, [], errors, 0);
      }

      if (!outcome.ok) {
        void log.warn(
          `coverage-delta: ${tool.id} did not produce coverage data: ${outcome.reason ?? 'unknown'}`,
        );
        errors.push({
          message: `coverage-delta: ${tool.id} did not produce coverage data`,
          cause: outcome.reason,
          fatal: false,
        });
        return finalize(started, [], errors, 0);
      }

      let coverage: CoverageMap | null;
      try {
        coverage = load(tool, deps);
      } catch (err) {
        void log.warn(
          `coverage-delta: failed to load coverage report: ${(err as Error).message}`,
        );
        errors.push({
          message: 'coverage-delta: failed to load coverage report',
          cause: (err as Error).message,
          fatal: false,
        });
        return finalize(started, [], errors, 0);
      }
      if (coverage === null) {
        return finalize(started, [], errors, 0);
      }

      // Build a (workspace-relative POSIX path) → FileCoverage map so the
      // per-changed-file lookup is O(1) and tolerant of absolute paths the
      // tool may emit.
      const byRepoPath = new Map<string, FileCoverage>();
      for (const [rawPath, fileCov] of Object.entries(coverage)) {
        if (fileCov === undefined || fileCov === null) continue;
        const rel = normalizeReportPath(deps.workspaceDir, rawPath);
        byRepoPath.set(rel, fileCov);
      }

      for (const file of deps.changedFiles) {
        if (file.is_binary || file.is_generated) continue;
        if (file.added_lines.size === 0) continue;
        const fc = byRepoPath.get(file.path);
        if (fc === undefined) continue;
        files_examined += 1;

        const uncovered = uncoveredLines(fc);
        // Iterate `added_lines` (the strict '+' lines), NOT `reviewable_lines`.
        // A context line that lacks coverage was already uncovered before
        // this PR; flagging it here would be noise the operator can't act on.
        for (const lineNo of file.added_lines) {
          if (!uncovered.has(lineNo)) continue;
          const finding = buildFinding(tool, file.path, lineNo);
          const match = deps.ignoreList.matches(finding);
          if (match.ignored) {
            if (match.expired) {
              void log.notice(
                `coverage-delta: ignore entry for ${finding.rule_id} (${finding.file_path}:${finding.line}) is expired; finding still suppressed but will need refresh. Reason: ${match.reason ?? '(no reason)'}`,
              );
            }
            continue;
          }
          findings.push(finding);
        }
      }

      return finalize(started, findings, errors, files_examined);
    },
  };
}

/**
 * Detect which coverage tool the project uses. Returns null when no
 * supported tool is configured in the workspace.
 *
 * Priority follows the deliverable: vitest → jest → pytest-cov → none.
 */
export function detectCoverageTool(deps: ScannerDeps): DetectedTool | null {
  const ws = deps.workspaceDir;
  const pkgJson = readJsonIfExists(path.join(ws, 'package.json'));

  // Vitest: explicit coverage script or vitest as a (dev)dep.
  if (
    pkgJson !== null &&
    (hasCoverageScript(pkgJson) || hasNamedDep(pkgJson, 'vitest')) &&
    hasJsOrTsChange(deps.changedFiles)
  ) {
    // Even when both vitest and jest are present, the dep ordering means
    // vitest wins — that's the documented priority. Repos using both should
    // prefer vitest (the more modern choice and the one this repo itself uses).
    if (hasNamedDep(pkgJson, 'vitest') || hasViteConfig(ws)) {
      return {
        id: 'vitest',
        // Vitest's `--coverage --reporter=json` writes coverage data to
        // `coverage/coverage-final.json` by default (controlled by the
        // istanbul reporter under the hood). We read this artifact rather
        // than the stdout reporter so the parsing path stays consistent
        // across CI configs that customize stdout reporters.
        artifact: path.join(ws, 'coverage', 'coverage-final.json'),
      };
    }
  }

  // Jest: explicit jest config or named dep. Skip when vitest already
  // claimed the workspace above (the if/return above already short-circuits).
  if (
    pkgJson !== null &&
    (hasNamedDep(pkgJson, 'jest') ||
      pkgJson.jest !== undefined ||
      hasJestConfig(ws)) &&
    hasJsOrTsChange(deps.changedFiles)
  ) {
    return {
      id: 'jest',
      artifact: path.join(ws, 'coverage', 'coverage-final.json'),
    };
  }

  // pytest-cov: any of the canonical Python config files exist AND the PR
  // touches a .py / .pyi file. Without a Python file we'd be spinning up
  // pytest on a non-Python PR for nothing.
  if (hasPythonProject(ws) && hasPythonChange(deps.changedFiles)) {
    return {
      id: 'pytest-cov',
      // `pytest --cov --cov-report=json` writes to `coverage.json` in the
      // current working directory by default. We pin the path explicitly
      // via `--cov-report=json:<path>` in runCoverageCli so this stays in
      // sync.
      artifact: path.join(ws, 'coverage.json'),
    };
  }

  return null;
}

function hasJsOrTsChange(files: readonly ChangedFile[]): boolean {
  for (const f of files) {
    if (f.is_binary || f.is_generated) continue;
    if (JS_SOURCE_EXTENSION.test(f.path)) return true;
  }
  return false;
}

function hasPythonChange(files: readonly ChangedFile[]): boolean {
  for (const f of files) {
    if (f.is_binary || f.is_generated) continue;
    if (PYTHON_SOURCE_EXTENSION.test(f.path)) return true;
  }
  return false;
}

/** Shape of the parsed package.json. We don't validate, we just probe. */
interface MinimalPackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  jest?: unknown;
}

function readJsonIfExists(p: string): MinimalPackageJson | null {
  try {
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as MinimalPackageJson;
  } catch {
    // Malformed JSON, permission errors, anything else — treat as "no config".
    return null;
  }
}

/**
 * Detect a coverage-style script in package.json. We check both
 * `scripts.coverage` and `scripts['test:coverage']` (the two conventions
 * called out in the deliverable). String content doesn't matter — the
 * presence of the script is the signal that the project considers coverage
 * a first-class workflow.
 */
function hasCoverageScript(pkg: MinimalPackageJson): boolean {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return false;
  return (
    typeof scripts.coverage === 'string' ||
    typeof scripts['test:coverage'] === 'string'
  );
}

function hasNamedDep(pkg: MinimalPackageJson, name: string): boolean {
  return (
    (pkg.dependencies?.[name] !== undefined) ||
    (pkg.devDependencies?.[name] !== undefined) ||
    (pkg.peerDependencies?.[name] !== undefined) ||
    (pkg.optionalDependencies?.[name] !== undefined)
  );
}

/** Pick up vitest config files even when the dep isn't installed at
 *  inspect-time (e.g. monorepo workspaces where the root package.json doesn't
 *  list it but a `vitest.config.ts` sits next to it). */
function hasViteConfig(workspaceDir: string): boolean {
  return (
    existsSync(path.join(workspaceDir, 'vitest.config.ts')) ||
    existsSync(path.join(workspaceDir, 'vitest.config.js')) ||
    existsSync(path.join(workspaceDir, 'vitest.config.mjs'))
  );
}

function hasJestConfig(workspaceDir: string): boolean {
  return (
    existsSync(path.join(workspaceDir, 'jest.config.js')) ||
    existsSync(path.join(workspaceDir, 'jest.config.ts')) ||
    existsSync(path.join(workspaceDir, 'jest.config.mjs')) ||
    existsSync(path.join(workspaceDir, 'jest.config.cjs')) ||
    existsSync(path.join(workspaceDir, 'jest.config.json'))
  );
}

/** Any of the canonical Python project markers. We don't require pytest-cov
 *  to be explicitly named — `pytest --cov` shells out to coverage.py which
 *  is the de-facto standard, so detecting "this is a pytest project" is
 *  sufficient. */
function hasPythonProject(workspaceDir: string): boolean {
  return (
    existsSync(path.join(workspaceDir, 'pyproject.toml')) ||
    existsSync(path.join(workspaceDir, 'pytest.ini')) ||
    existsSync(path.join(workspaceDir, 'setup.cfg')) ||
    existsSync(path.join(workspaceDir, 'conftest.py'))
  );
}

/**
 * Translate a path emitted by the coverage tool into the repo-relative POSIX
 * form `changedFiles` is keyed by. Absolute paths get re-relativized against
 * the workspace; relative paths pass through normalized. Windows separators
 * get flipped to '/'.
 *
 * Mirrors `normalizeToolPath` in `src/scanners/sast/linter.ts`. Kept inline
 * here so the scanner doesn't depend on the SAST helper module (which would
 * also drag the LinterModule types into this top-level scanner's surface).
 */
export function normalizeReportPath(workspaceDir: string, toolPath: string): string {
  const normalized = path.isAbsolute(toolPath)
    ? path.relative(workspaceDir, toolPath)
    : path.normalize(toolPath);
  return normalized.split(path.sep).join('/');
}

/**
 * Compute the set of line numbers that have at least one statement with hit
 * count zero. A line is "uncovered" if it contains an uncovered statement —
 * even if other statements on the same line ARE covered (e.g. a `return
 * cond ? a : b` where one branch ran and the other didn't). This matches
 * coverage tools' own line-level reporting.
 *
 * NOTE: a line with a covered statement and NO uncovered statement is
 * considered covered. We do NOT mark it uncovered just because some
 * statements run zero times if at least one of the line's statements ran;
 * the deliverable spec says "covered if at least one statement on that line
 * has count > 0". We keep that semantic.
 */
export function uncoveredLines(fc: FileCoverage): Set<number> {
  // For each line, track the highest hit count observed across all statements
  // that start on that line. If every statement on the line is zero, the line
  // is uncovered. Storing the max (not just "any nonzero") lets the assertion
  // be checked in a single pass.
  const maxHitsByLine = new Map<number, number>();
  for (const [stmtId, loc] of Object.entries(fc.statementMap)) {
    if (loc === undefined || loc === null || loc.start === undefined) continue;
    const startLine = loc.start.line;
    if (typeof startLine !== 'number' || !Number.isFinite(startLine)) continue;
    const hits = fc.s[stmtId];
    const count = typeof hits === 'number' ? hits : 0;
    const prev = maxHitsByLine.get(startLine);
    if (prev === undefined || count > prev) {
      maxHitsByLine.set(startLine, count);
    }
    // Also mark the end-line if the statement spans multiple lines AND we
    // haven't already seen a strictly-larger hit count for it. This handles
    // multi-line statements where the JSON only records one statementMap
    // entry — without this an uncovered multi-line statement would only
    // flag its first line.
    const endLine = loc.end?.line;
    if (typeof endLine === 'number' && endLine > startLine) {
      for (let l = startLine + 1; l <= endLine; l += 1) {
        const p = maxHitsByLine.get(l);
        if (p === undefined || count > p) maxHitsByLine.set(l, count);
      }
    }
  }
  const out = new Set<number>();
  for (const [line, max] of maxHitsByLine) {
    if (max === 0) out.add(line);
  }
  return out;
}

function buildFinding(
  tool: DetectedTool,
  file_path: string,
  line: number,
): ScanFinding {
  const rule_id = `coverage:${tool.id}:uncovered-line`;
  return {
    scanner: SCANNER_ID,
    rule_id,
    file_path,
    line,
    severity: 'minor',
    category: 'test-gap',
    title: `Untested line in ${path.basename(file_path)}:${line}`,
    description:
      'This added line is not exercised by the test suite. Consider adding a test that covers this path, or move the logic behind a tested entry point.',
    confidence: 'medium',
    evidence: { kind: 'coverage', tool: tool.id },
    fingerprint: `${SCANNER_ID}:${tool.id}:${file_path}:${line}`,
  };
}

/**
 * Spawn the coverage CLI for the detected tool. Resolves with
 * `{ ok: true }` when the run produced a coverage artifact, regardless of
 * test pass/fail. Resolves with `{ ok: false, reason }` for missing
 * binaries, timeouts, or absent artifacts.
 *
 * Never throws — every failure mode maps to a `{ ok: false }`.
 */
export async function runCoverageCli(
  tool: DetectedTool,
  deps: ScannerDeps,
): Promise<CoverageRunOutcome> {
  const { command, args, env } = buildCoverageInvocation(tool, deps);
  return new Promise<CoverageRunOutcome>((resolve) => {
    const child = spawn(command, args, {
      cwd: deps.workspaceDir,
      env,
      // We never run under shell:true here. Coverage commands always go
      // through `npx` / `pytest`, never a .cmd shim, so the shell-quoting
      // gymnastics the SAST linters need don't apply.
      shell: false,
    });
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Artifact existence is the contract for "we got coverage data,"
      // independent of test exit code. A test suite with failures still
      // produces an artifact under both vitest, jest, and pytest-cov in
      // the JSON-reporter mode we use.
      if (existsSync(tool.artifact)) {
        resolve({ ok: true });
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim().slice(0, 500);
        resolve({
          ok: false,
          reason: `${tool.id} produced no coverage artifact at ${tool.artifact}${stderr ? `; stderr: ${stderr}` : ''}`,
        });
      }
    };
    const finishErr = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ ok: false, reason });
    };
    const timer = setTimeout(() => {
      finishErr(`${tool.id} timed out after ${COVERAGE_TIMEOUT_MS}ms`);
    }, COVERAGE_TIMEOUT_MS);
    // Drain stdout to avoid the OS pipe buffer filling up and stalling the
    // child. We discard the bytes since we read the JSON from disk; capping
    // stderr at ~16 KB to keep memory bounded on chatty test runs.
    child.stdout.on('data', () => undefined);
    const STDERR_BUDGET = 16 * 1024;
    let stderrTotal = 0;
    child.stderr.on('data', (b: Buffer) => {
      if (stderrTotal >= STDERR_BUDGET) return;
      stderrChunks.push(b);
      stderrTotal += b.length;
    });
    deps.signal.addEventListener(
      'abort',
      () => finishErr(`${tool.id} aborted`),
      { once: true },
    );
    child.on('close', () => finishOk());
    // ENOENT etc. — surface as a missing-binary failure so the caller logs
    // and degrades to empty findings rather than throwing.
    child.on('error', (err) => finishErr(`${tool.id} spawn error: ${err.message}`));
  });
}

interface CoverageInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function buildCoverageInvocation(
  tool: DetectedTool,
  _deps: ScannerDeps,
): CoverageInvocation {
  // We inherit the parent env here (unlike the SAST linters, which
  // tightly allowlist). Coverage tools commonly need user-defined env vars
  // (DATABASE_URL, etc.) to run the test suite at all; stripping them
  // would silently break the run. Operators on `pull_request_target` should
  // already be treating this action as code-exec-on-PR.
  const env = { ...process.env };
  switch (tool.id) {
    case 'vitest':
      return {
        command: 'npx',
        // `vitest run` is the explicit non-watch entry point. `--coverage`
        // turns on the v8 / istanbul reporter; `--reporter=json` makes
        // stdout machine-readable (we don't read stdout but it stops the
        // CLI from printing a noisy human reporter to the runner log).
        args: ['vitest', 'run', '--coverage', '--reporter=json'],
        env,
      };
    case 'jest':
      return {
        command: 'npx',
        // `--coverageReporters=json` produces the Istanbul-format
        // `coverage/coverage-final.json` that downstream parsing expects.
        // We don't override --coverageDirectory because the default
        // (`<workspace>/coverage`) is what `detectCoverageTool` declared
        // as the artifact path.
        args: ['jest', '--coverage', '--coverageReporters=json'],
        env,
      };
    case 'pytest-cov':
      return {
        command: 'pytest',
        // Pin the JSON report destination explicitly so it matches the
        // `tool.artifact` we declared in detection. `--cov` without an
        // argument tells coverage.py to measure everything pytest runs.
        args: ['--cov', `--cov-report=json:${tool.artifact}`],
        env,
      };
  }
}

/**
 * Load the JSON coverage artifact for a detected tool and translate it into
 * the Istanbul-style `CoverageMap` the scanner's line-coverage logic expects.
 *
 * Returns null when the artifact is absent, malformed, or empty. Never
 * throws — load errors propagate as `null` so the caller can degrade to an
 * empty findings list.
 */
export function loadCoverageMap(
  tool: DetectedTool,
  _deps: ScannerDeps,
): CoverageMap | null {
  if (!existsSync(tool.artifact)) return null;
  let raw: string;
  try {
    // We could stream-parse here for very large artifacts, but in practice
    // coverage-final.json files are <50 MB even on monorepos and the
    // bounded read keeps the implementation simple. The cap is enforced via
    // a length check after the read so very-large files fail predictably
    // instead of OOM-ing the runner.
    raw = readFileSync(tool.artifact, 'utf-8');
  } catch {
    return null;
  }
  if (raw.length > MAX_COVERAGE_JSON_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  switch (tool.id) {
    case 'vitest':
    case 'jest':
      // Istanbul format — pass through after a shallow shape check.
      return coerceIstanbulMap(parsed as Record<string, unknown>);
    case 'pytest-cov':
      return translatePythonCoverage(parsed as PythonCoverageReport);
  }
}

/**
 * Shape-check + normalize an Istanbul-format coverage report. We don't try
 * to be exhaustive — we just confirm the per-file objects have `statementMap`
 * and `s` and drop any that don't.
 */
function coerceIstanbulMap(raw: Record<string, unknown>): CoverageMap {
  const out: CoverageMap = {};
  for (const [path_, fc] of Object.entries(raw)) {
    if (fc === null || typeof fc !== 'object') continue;
    const obj = fc as Record<string, unknown>;
    const statementMap = obj.statementMap;
    const s = obj.s;
    if (
      statementMap === null ||
      typeof statementMap !== 'object' ||
      s === null ||
      typeof s !== 'object'
    ) {
      continue;
    }
    out[path_] = {
      statementMap: statementMap as Record<string, StatementLocation>,
      s: s as Record<string, number>,
    };
  }
  return out;
}

/**
 * Translate coverage.py's `--cov-report=json` shape into the Istanbul map
 * the rest of the scanner expects.
 *
 * coverage.py exposes per-file `executed_lines` and `missing_lines` arrays —
 * a cleaner shape than Istanbul's statementMap. We synthesize one
 * pseudo-statement per line so the uncoveredLines() pass produces the same
 * output regardless of which tool generated the report.
 */
function translatePythonCoverage(report: PythonCoverageReport): CoverageMap {
  const out: CoverageMap = {};
  if (!report.files || typeof report.files !== 'object') return out;
  for (const [path_, file] of Object.entries(report.files)) {
    if (file === null || typeof file !== 'object') continue;
    const executed = Array.isArray(file.executed_lines) ? file.executed_lines : [];
    const missing = Array.isArray(file.missing_lines) ? file.missing_lines : [];
    const statementMap: Record<string, StatementLocation> = {};
    const s: Record<string, number> = {};
    let nextId = 0;
    for (const line of executed) {
      if (typeof line !== 'number') continue;
      const id = String(nextId++);
      statementMap[id] = { start: { line }, end: { line } };
      s[id] = 1;
    }
    for (const line of missing) {
      if (typeof line !== 'number') continue;
      const id = String(nextId++);
      statementMap[id] = { start: { line }, end: { line } };
      s[id] = 0;
    }
    out[path_] = { statementMap, s };
  }
  return out;
}

function finalize(
  started: number,
  findings: ScanFinding[],
  errors: ScanError[],
  files_examined: number,
): ScanResult {
  const metrics: ScannerMetrics = {
    duration_ms: Date.now() - started,
    files_examined,
    network_calls: 0,
    cache_hits: 0,
  };
  return { scanner: SCANNER_ID, findings, errors, metrics };
}
