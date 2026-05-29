/**
 * tsc (TypeScript compiler) linter module — runs `tsc --noEmit` against the
 * PR commit and surfaces type-check diagnostics as deterministic SAST
 * findings.
 *
 * Why this exists: in strict mode, tsc catches a long tail of bugs (nullable
 * misuse, contract violations, narrowed-type drift after refactors) that
 * the agent would otherwise spend tool-loop turns rediscovering. Running
 * tsc once produces every diagnostic the project has, restricted to lines
 * the PR added — zero LLM cost, one binary invocation.
 *
 * Activation:
 *   1. `tsconfig.json` at workspace root (quiet skip if absent — the
 *      repo isn't a TypeScript project; ts files alone don't mean tsc
 *      will succeed without a config to define lib / target / paths).
 *   2. `<workspace>/node_modules/.bin/tsc` (workspace-local pinned version).
 *      No PATH fallback: we want the project's own typescript version,
 *      not whatever happens to be on the runner. Matches eslint.ts'
 *      strictness.
 *
 * Quiet skip when either activation gate fails — many TS repos don't run
 * tsc as a CI step (some rely on the bundler), and that's not a Vor failure.
 *
 * Whole-project: tsc reads tsconfig.json and analyzes its `include` set;
 * we don't pass file argv (passing files explicitly causes tsc to IGNORE
 * tsconfig.json — see `--help` text "Ignoring tsconfig.json, compiles
 * the specified files with default compiler options"). The orchestrator
 * uses the `wholeProject: true` flag to hand us the full liveFiles set
 * for output attribution.
 *
 * Output format (with `--pretty false`):
 *   path/to/file.ts(line,col): error TS2322: Type 'X' is not assignable to type 'Y'.
 *
 * Multi-line: when a message wraps (e.g. "Type 'A' is not assignable to
 * type 'B'.\n  Property 'foo' is missing in type 'A' but required in type
 * 'B'."), tsc emits the continuation lines indented and without a leading
 * `path(line,col):` prefix. We accumulate continuation lines into the
 * preceding diagnostic.
 *
 * Severity mapping:
 *   - `error` → 'important' (tsc errors are real bugs in strict mode)
 *   - `warning` → 'minor' (tsc rarely emits warnings, but be defensive)
 *
 * Exit code handling: tsc exits 1 (or 2) when diagnostics are present —
 * that's NORMAL, not a scanner failure. Only treat exit codes as failure
 * when the process couldn't even start (ENOENT) or stderr indicates a
 * real crash (e.g. SyntaxError loading tsconfig).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  buildSpawnInvocation,
  findWorkspaceBinary,
  normalizeToolPath,
  shellQuoteBinary,
  type LinterModule,
  type LinterRun,
  type ResolvedBinary,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'tsc';
const TIMEOUT_MS = 120_000;
const TARGET_EXTENSIONS = /\.(ts|tsx|cts|mts)$/;

/**
 * Diagnostic line shape produced by tsc with `--pretty false`. Exported
 * for testing — the parser has invariants worth pinning (column index
 * isn't part of GitHub's comment anchor, but mis-parsing the line number
 * silently drops every finding).
 */
export interface TscDiagnostic {
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/**
 * Anchored at start of line:
 *   path/to/file.ts(line,col): error TS2322: ...
 *
 * Windows paths can contain a drive letter (`C:\foo\bar.ts(...)...`) — the
 * `:` after the drive letter would confuse a greedy match, so the file-path
 * group is non-greedy and we anchor on the literal `(<digits>,<digits>):`
 * sequence which only appears at the line/column position.
 *
 * tsc never emits `info` diagnostics in its CLI output today (only in the
 * editor LSP), so the severity alternation is `error|warning` only.
 */
const DIAG_LINE_REGEX = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

export const tscLinter: LinterModule = {
  id: ID,
  // tsc analyzes the whole project via tsconfig.json's `include` set; we
  // don't pass file argv. The orchestrator uses this flag to hand us the
  // full liveFiles set (not just the TS/TSX subset) so any PR-changed
  // path tsc references can be attributed — same shape knip uses.
  wholeProject: true,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some((f) => TARGET_EXTENSIONS.test(f.path) && !f.is_binary && !f.is_generated);
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];

    // Per-linter opt-out. Default ON when the field is omitted (matches
    // the "scanners are enabled unless turned off" stance of the top-level
    // `sast.enabled` flag). Operators who want to disable tsc per-repo
    // set `security.scanners.sast.tsc.enabled: false` in `.vor.yml`.
    const tscConfig = deps.config.scanners.sast.tsc;
    if (tscConfig?.enabled === false) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    // tsconfig.json is the activation gate. Without it, tsc falls back to
    // compiling specified files with DEFAULT options (no strict, no lib,
    // no jsx) which produces useless garbage diagnostics. Quiet skip is
    // the right behavior for repos that aren't TypeScript projects (even
    // if they happen to contain a stray .ts file).
    const tsconfigPath = path.join(deps.workspaceDir, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
      await logger.debug(`tsc: skipped — no tsconfig.json at ${tsconfigPath}`);
      return { findings: [], errors: [], filesExamined: 0 };
    }

    const bin = findWorkspaceBinary([path.join(deps.workspaceDir, 'node_modules', '.bin', 'tsc')]);
    if (bin === null) {
      // MUST `await` — see eslint.ts for the full rationale (logger.debug
      // returns a Promise that, fire-and-forget, leaves a dangling
      // microtask keeping vitest workers alive past test completion).
      await logger.debug(
        `tsc: skipped — no tsc binary at ${deps.workspaceDir}/node_modules/.bin/tsc (workspace not npm-installed?)`,
      );
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Multiple "binary not installed" signals across platforms. Same
      // shape as knip.ts — see there for the rationale on why we match
      // `command not found` and not bare `not found`.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('command not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `tsc failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    const diagnostics = parseTscOutput(rawOutput);
    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const diag of diagnostics) {
      const relPath = normalizeToolPath(deps.workspaceDir, diag.filePath);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(diag.line)) continue;
      findings.push(buildFinding(changedFile.path, diag));
    }

    // tsc runs whole-project — report 0 here like knip does (we never
    // scoped the scan to targetFiles, so claiming we "examined N files"
    // would be misleading).
    return { findings, errors, filesExamined: 0 };
  },
};

/**
 * Parse tsc's `--pretty false` output into structured diagnostics.
 *
 * The output is line-oriented but a single diagnostic can span multiple
 * lines: tsc wraps long messages and continuation lines have no
 * `path(line,col):` prefix. We accumulate continuation text onto the
 * most-recently-seen diagnostic.
 *
 * Lines that don't match the diagnostic anchor AND don't look like a
 * continuation (e.g. tsc's "Found N errors." summary) are silently
 * skipped — the regex is the schema, anything outside it is non-finding
 * noise.
 *
 * Exported so the tests can pin the contract directly without spawning a
 * real tsc process.
 */
export function parseTscOutput(raw: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  // Split on \n (handles both Unix and Windows line endings — \r is
  // tolerated by trimming below). Don't drop empty lines here; let the
  // continuation logic decide whether to attach them.
  const lines = raw.split('\n');
  for (const rawLine of lines) {
    // Strip trailing \r so Windows-style CRLF doesn't break the regex
    // anchor on `$`. Trim only the right side — leading whitespace is
    // the signal we use to detect continuation lines.
    const line = rawLine.replace(/\r$/, '');
    const match = DIAG_LINE_REGEX.exec(line);
    if (match !== null) {
      const [, filePath, lineStr, colStr, severity, code, message] = match;
      const lineNum = Number.parseInt(lineStr ?? '', 10);
      const colNum = Number.parseInt(colStr ?? '', 10);
      // Defensive — DIAG_LINE_REGEX already requires \d+ so these should
      // always be finite, but skip rather than push NaN.
      if (!Number.isFinite(lineNum) || lineNum <= 0) continue;
      diagnostics.push({
        filePath: filePath ?? '',
        line: lineNum,
        column: Number.isFinite(colNum) ? colNum : 0,
        // Cast is safe — regex alternation restricts severity to these
        // two strings.
        severity: severity as 'error' | 'warning',
        code: code ?? '',
        message: message ?? '',
      });
      continue;
    }
    // Continuation: non-matching line that starts with whitespace AND a
    // diagnostic has already been collected. Append to the prior message
    // with a newline so the full text remains readable in PR comments.
    // Empty lines and lines with no leading whitespace are NOT
    // continuations (they're separators or summary lines like
    // "Found 3 errors in 2 files."), so we drop them.
    const isContinuation = diagnostics.length > 0 && line.length > 0 && /^\s/.test(line);
    if (isContinuation) {
      const last = diagnostics[diagnostics.length - 1]!;
      last.message = `${last.message}\n${line.trim()}`;
    }
  }
  return diagnostics;
}

function runCli(bin: ResolvedBinary, deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    // Flags:
    //   --noEmit            type-check only, don't write .js output. Even
    //                       though tsconfig.json may set noEmit:true, set
    //                       it explicitly so we work against configs that
    //                       don't.
    //   --pretty false      machine-readable output (no ANSI colors, no
    //                       fancy unicode box-drawing). Critical: with
    //                       --pretty true (the default in modern tsc),
    //                       diagnostics use a multi-line frame format
    //                       that parseTscOutput can't decode.
    //   --incremental false explicitly disable .tsbuildinfo caching. The
    //                       tsbuildinfo file written by incremental builds
    //                       lives in the repo workspace; running the
    //                       scanner shouldn't create build artifacts that
    //                       later steps in the same workflow might commit
    //                       or that show up in the next PR's diff.
    //
    // No file argv — tsc compiles whatever tsconfig.json's `include`
    // resolves to. Passing files explicitly causes tsc to IGNORE
    // tsconfig.json (per its own --help text), which would silently lose
    // strict mode and lib settings.
    //
    // DEP0190 — see eslint.ts for the rationale on buildSpawnInvocation.
    const { command, argsForSpawn } = buildSpawnInvocation(
      shellQuoteBinary(bin),
      ['--noEmit', '--pretty', 'false', '--incremental', 'false'],
      bin.needsShell,
    );
    const spawnOptions = {
      cwd: deps.workspaceDir,
      env: buildLinterEnv(),
      shell: bin.needsShell,
    };
    const child =
      argsForSpawn === null
        ? spawn(command, spawnOptions)
        : spawn(command, argsForSpawn, spawnOptions);
    // Buffer accumulation — avoids O(n²) string concat on large outputs
    // and UTF-8 corruption across chunk boundaries. tsc output on a
    // monorepo with hundreds of errors can be MBs.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`tsc timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (b: Buffer) => {
      stdoutChunks.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      stderrChunks.push(b);
    });
    deps.signal.addEventListener(
      'abort',
      () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('tsc aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output is unreliable.
        reject(new Error(`tsc killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      // tsc exit codes:
      //   0 = no errors
      //   1 = errors found
      //   2 = errors found (some configurations)
      //   3 = command-line option error
      //   4 = config-file error (couldn't parse tsconfig.json)
      //   5 = compiler internal error (crash)
      //
      // Codes 1 and 2 are EXPECTED when type errors exist — that's the
      // whole point of running tsc. Treat codes >2 as real failures
      // (couldn't parse tsconfig, internal crash, etc.) — the stdout
      // for those is typically empty or garbage and the stderr has the
      // real reason. Reject so the orchestrator surfaces a ScanError
      // rather than emitting bogus findings parsed from junk output.
      if (code > 2) {
        // Surface BOTH stderr (where compiler errors land) AND stdout
        // (where config-parse errors sometimes land in tsc — config
        // file diagnostics use the same DIAG_LINE_REGEX shape so they'd
        // pass parsing, but emitting them as findings against arbitrary
        // user files is wrong; explicit failure is the safer behavior).
        const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
        reject(new Error(`tsc exited ${code}: ${detail}`));
        return;
      }
      // Diagnostics go to stdout. stderr is usually empty when tsc ran
      // cleanly; if non-empty under code 0-2 it's typically progress
      // chatter (e.g. on rare `--listFiles` invocations) which is harmless
      // to drop.
      resolve(stdout);
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildFinding(filePath: string, diag: TscDiagnostic): ScanFinding {
  const severity: Severity = diag.severity === 'error' ? 'important' : 'minor';
  // 'bug' is the closest semantic match in CATEGORIES (the task spec
  // suggested 'type-error' but that's not in the enum — `bug` covers
  // every type-system violation strict-mode tsc surfaces, and it routes
  // findings through the same downstream rendering as eslint's promise
  // rules and dart's compile errors).
  const category: Category = 'bug';
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${diag.code}:${filePath}:${diag.line}`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${diag.code}`,
    file_path: filePath,
    line: diag.line,
    severity,
    category,
    title: renderTitle(diag),
    description: renderDescription(diag),
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function renderTitle(diag: TscDiagnostic): string {
  const ruleStr = `[${ID}/${diag.code}] `;
  const firstLine = diag.message.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(diag: TscDiagnostic): string {
  return `TypeScript compiler diagnostic: \`${diag.code}\` (${diag.severity}).\n\n` + diag.message;
}
