/**
 * Go linter module — runs golangci-lint against the packages a PR's
 * changed .go files belong to.
 *
 * Why golangci-lint specifically: it's the de-facto Go meta-linter,
 * bundling ~50 analyzers (govet, staticcheck, gosec, errcheck,
 * ineffassign, …) behind a single binary with stable JSON output. Before
 * this module Go was covered only by semgrep's `--config=auto`, which is
 * the slowest/costliest linter (network fetch + 180s cap) and shallow on
 * Go compared to the ecosystem's own tooling.
 *
 * Activation order:
 *   1. `<workspace>/bin/golangci-lint` (project-local `make`/`go install`)
 *   2. `golangci-lint` on PATH (system / GOPATH/bin / runner image)
 *
 * Returns empty quietly when neither resolves — many Go repos don't ship
 * golangci-lint in CI and that's not a scanner failure.
 *
 * Invocation model differs from ruff/dart: golangci-lint analyzes
 * *packages* (it compiles them), so feeding it individual .go files is
 * fragile. We pass the unique set of directories the changed files live
 * in and then filter the resulting issues back down to the changed files
 * + lines this PR actually added — the same post-filter every module does.
 *
 * Severity / category mapping is keyed off the issue's `FromLinter`
 * (deterministic, like ruff's code-prefix mapping) rather than
 * golangci-lint's optional and config-dependent `Severity` field:
 *   - gosec → important / vulnerability
 *   - govet / staticcheck / errcheck / ineffassign / … → important / bug
 *   - everything else (revive, gofmt, gocritic, …) → minor / readability
 *
 * golangci-lint JSON format: https://golangci-lint.run/usage/faq/#how-to-integrate
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  buildSpawnInvocation,
  filterShellSafePaths,
  findWorkspaceBinary,
  normalizeToolPath,
  shellQuoteBinary,
  type LinterModule,
  type LinterRun,
  type ResolvedBinary,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'golangci-lint';
const TIMEOUT_MS = 120_000;
const TARGET_EXTENSION = /\.go$/;

// golangci-lint's own timer. Set below our SIGKILL (TIMEOUT_MS) so the
// tool self-bounds and surfaces a clean error instead of being killed
// mid-write, which would truncate the JSON and trip a parse failure.
const GOLANGCI_INTERNAL_TIMEOUT = '110s';

interface GolangciPos {
  Filename: string;
  Line: number;
  Column?: number;
}

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  Pos: GolangciPos;
}

interface GolangciOutput {
  // `Issues` is `null` (not `[]`) when golangci-lint finds nothing.
  Issues: GolangciIssue[] | null;
}

export const golangLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSION.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];
    const bin = locateBin(deps.workspaceDir);

    // Targets are the package directories, not the files. Shell-injection
    // guard still applies — directory names come from PR paths and flow
    // into argv (and through cmd.exe when the binary is a Windows shim).
    const { safe, dropped } = filterShellSafePaths(
      dirsForGoFiles(targetFiles.map((f) => f.path)),
      bin.needsShell,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `golangci-lint: skipped ${dropped.length} dir(s) with shell-unsafe paths: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
      );
    }
    if (safe.length === 0) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runWithFallback(bin, safe, deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Quiet skip when golangci-lint isn't installed anywhere
      // resolvable. Same enumeration as ruff/dart — see ruff.ts for the
      // per-signal rationale. `command not found` is the specific POSIX
      // match (bare `not found` would swallow real "config not found"
      // errors); 9009/127 are the locale-independent exit codes.
      if (isMissingBinary(msg)) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `golangci-lint failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let output: GolangciOutput;
    try {
      output = JSON.parse(rawOutput) as GolangciOutput;
    } catch (err) {
      errors.push({
        message: `golangci-lint output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const issue of output.Issues ?? []) {
      if (issue.Pos === undefined) continue;
      const relPath = normalizeToolPath(deps.workspaceDir, issue.Pos.Filename);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(issue.Pos.Line)) continue;
      findings.push(buildFinding(changedFile.path, issue));
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

/**
 * Map changed .go file paths to the unique set of package directories to
 * hand golangci-lint. Root-level files map to `./` (the module root
 * package); nested files to `./<dir>`. The `./` prefix makes the targets
 * unambiguously relative package patterns rather than import paths.
 *
 * Exported for testing — the dedup + root-handling is the bit most likely
 * to regress silently (a wrong target means golangci-lint scans the wrong
 * package and every finding drops at the changedFiles lookup).
 */
export function dirsForGoFiles(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    // git diff paths are POSIX, so use path.posix to avoid backslash dirs
    // on Windows runners (which would then mismatch as targets).
    const dir = path.posix.dirname(p);
    dirs.add(dir === '.' ? './' : `./${dir}`);
  }
  return [...dirs];
}

function locateBin(workspaceDir: string): ResolvedBinary {
  // Project-local install first (matches the repo's pinned version /
  // .golangci.yml config). findWorkspaceBinary tries .cmd/.exe variants.
  const ws = findWorkspaceBinary([
    path.join(workspaceDir, 'bin', 'golangci-lint'),
  ]);
  if (ws !== null) return ws;
  // PATH-resolved. On Windows, global installs land as `.cmd`/`.exe`
  // shims that Node's `spawn` with shell:false can't execute for a bare
  // name, so force shell:true there so cmd.exe honors PATHEXT (mirrors
  // ruff.ts). ENOENT is caught by runCli and becomes a quiet skip.
  const isWindows = process.platform === 'win32';
  return { path: 'golangci-lint', needsShell: isWindows };
}

/**
 * Run golangci-lint, transparently handling the v1↔v2 CLI break.
 *
 * golangci-lint v2 (2025) removed `--out-format` in favor of
 * `--output.json.path=stdout`. Both versions emit the same `Issues[]`
 * JSON shape, so we try v1 flags first and, only when the failure is an
 * unknown-flag/usage error (not a missing binary and not a real run
 * failure), retry once with the v2 invocation.
 */
async function runWithFallback(
  bin: ResolvedBinary,
  dirs: string[],
  deps: ScannerDeps,
): Promise<string> {
  const common = ['run', '--issues-exit-code=0', `--timeout=${GOLANGCI_INTERNAL_TIMEOUT}`];
  try {
    return await runCli(bin, [...common, '--out-format=json', ...dirs], deps);
  } catch (err) {
    const msg = (err as Error).message;
    if (isMissingBinary(msg)) throw err;
    if (looksLikeUnknownFlag(msg)) {
      return runCli(bin, [...common, '--output.json.path=stdout', ...dirs], deps);
    }
    throw err;
  }
}

function isMissingBinary(msg: string): boolean {
  return (
    msg.includes('ENOENT') ||
    msg.includes('command not found') ||
    msg.includes('is not recognized') ||
    msg.includes('exited 9009') ||
    msg.includes('exited 127')
  );
}

function looksLikeUnknownFlag(msg: string): boolean {
  // golangci-lint v2 given a removed v1 flag prints e.g.
  // "Error: unknown flag: --out-format" and a "Usage:" block.
  return (
    msg.includes('unknown flag') ||
    msg.includes('unknown shorthand') ||
    msg.includes('unknown command') ||
    msg.includes('Usage:')
  );
}

function runCli(
  bin: ResolvedBinary,
  args: string[],
  deps: ScannerDeps,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // DEP0190 — see eslint.ts for the full rationale. args are already
    // shell-quoted (dirs via filterShellSafePaths, flags are literal).
    const { command, argsForSpawn } = buildSpawnInvocation(
      shellQuoteBinary(bin),
      args,
      bin.needsShell,
    );
    const spawnOptions = {
      cwd: deps.workspaceDir,
      env: buildLinterEnv(),
      shell: bin.needsShell,
    };
    const child = argsForSpawn === null
      ? spawn(command, spawnOptions)
      : spawn(command, argsForSpawn, spawnOptions);
    // Buffer accumulation — avoids O(n²) string concat on large outputs
    // and UTF-8 corruption across chunk boundaries.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`golangci-lint timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('golangci-lint aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`golangci-lint killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // --issues-exit-code=0 means a clean run AND a run with findings both
      // exit 0. Any non-zero exit is a real failure (bad flag, build error,
      // invalid config) — surface stderr so the v1→v2 fallback can detect
      // an unknown-flag error and the operator sees genuine failures.
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`golangci-lint exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildFinding(filePath: string, issue: GolangciIssue): ScanFinding {
  const fromLinter = issue.FromLinter.length > 0 ? issue.FromLinter : 'unknown';
  const severity: Severity = golangSeverity(fromLinter);
  const category: Category = golangCategory(fromLinter);
  const confidence: Confidence = 'high';
  const line = issue.Pos.Line;
  const fingerprint = `${ID}:${fromLinter}:${filePath}:${line}`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${fromLinter}`,
    file_path: filePath,
    line,
    severity,
    category,
    title: renderTitle(fromLinter, issue.Text),
    description: renderDescription(fromLinter, issue.Text),
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

// Linters whose findings are likely real bugs rather than style. Keyed on
// golangci-lint's `FromLinter` name. Everything not listed falls through
// to readability/minor.
const BUG_LINTERS: ReadonlySet<string> = new Set([
  'govet',
  'staticcheck',
  'errcheck',
  'ineffassign',
  'nilerr',
  'bodyclose',
  'gosimple',
  'unused',
  'typecheck',
  'rowserrcheck',
  'sqlclosecheck',
  'errorlint',
  'contextcheck',
]);

function isBugLinter(fromLinter: string): boolean {
  // staticcheck rule codes (SA1234) can surface as the linter name under
  // some configs — treat those as bugs too.
  return BUG_LINTERS.has(fromLinter) || /^SA\d/.test(fromLinter);
}

export function golangSeverity(fromLinter: string): Severity {
  // gosec = security analyzer; its findings are the highest-priority Go
  // SAST signal.
  if (fromLinter === 'gosec') return 'important';
  if (isBugLinter(fromLinter)) return 'important';
  return 'minor';
}

export function golangCategory(fromLinter: string): Category {
  if (fromLinter === 'gosec') return 'vulnerability';
  if (isBugLinter(fromLinter)) return 'bug';
  return 'readability';
}

function renderTitle(fromLinter: string, text: string): string {
  const ruleStr = `[${ID}/${fromLinter}] `;
  const firstLine = text.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(fromLinter: string, text: string): string {
  return `golangci-lint linter: \`${fromLinter}\`.\n\n${text}`;
}
