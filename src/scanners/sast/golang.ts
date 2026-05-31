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
 * fragile. We group the changed files by their nearest `go.mod` (the Go
 * module root), run golangci-lint once per module *from that module's
 * directory* with package-dir targets relative to it, then filter the
 * resulting issues back down to the changed files + lines this PR added.
 *
 * Running from the module root (not always the repo root) matters for
 * repos that keep Go in a subdirectory module (e.g. `backend/go.mod` with
 * no root `go.mod`): `go list ./backend` from the repo root fails with
 * "go.mod file not found", so the linter would exit before producing JSON
 * and the PR would silently get zero Go findings.
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
import { existsSync } from 'node:fs';
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
    return files.some((f) => TARGET_EXTENSION.test(f.path) && !f.is_binary && !f.is_generated);
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];
    const bin = locateBin(deps.workspaceDir);
    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));

    // Group the changed files by their nearest go.mod so each Go module is
    // linted from its own root (see header). Falls back to the repo root
    // for files with no go.mod ancestor.
    const groups = groupByGoModule(
      targetFiles.map((f) => f.path),
      (dirRel) => existsSync(path.join(deps.workspaceDir, dirRel, 'go.mod')),
    );

    const findings: ScanFinding[] = [];
    let ranAny = false;
    for (const group of groups) {
      // Targets are the package directories (relative to the module root),
      // not the files. Shell-injection guard still applies — directory
      // names come from PR paths and flow into argv (and through cmd.exe
      // when the binary is a Windows shim).
      const { safe, dropped } = filterShellSafePaths(group.dirs, bin.needsShell);
      if (dropped.length > 0) {
        await logger.warn(
          `golangci-lint: skipped ${dropped.length} dir(s) with shell-unsafe paths: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
        );
      }
      if (safe.length === 0) continue;

      const cwd = group.root === '.' ? deps.workspaceDir : path.join(deps.workspaceDir, group.root);

      let rawOutput: string;
      try {
        rawOutput = await runWithFallback(bin, safe, deps, cwd);
      } catch (err) {
        const msg = (err as Error).message;
        // Quiet skip when golangci-lint isn't installed anywhere
        // resolvable. Same enumeration as ruff/dart — see ruff.ts for the
        // per-signal rationale. `command not found` is the specific POSIX
        // match (bare `not found` would swallow real "config not found"
        // errors); 9009/127 are the locale-independent exit codes. The
        // binary is the same across module groups, so a miss on one means
        // a miss on all — stop and report the quiet no-op.
        if (isMissingBinary(msg)) {
          return { findings, errors, filesExamined: ranAny ? targetFiles.length : 0 };
        }
        errors.push({
          message: `golangci-lint failed (module ${group.root}): ${msg}`,
          fatal: false,
        });
        continue;
      }
      ranAny = true;

      let output: GolangciOutput;
      try {
        output = JSON.parse(rawOutput) as GolangciOutput;
      } catch (err) {
        errors.push({
          message: `golangci-lint output parse failed (module ${group.root}): ${(err as Error).message}`,
          fatal: false,
        });
        continue;
      }

      for (const issue of output.Issues ?? []) {
        if (issue.Pos === undefined) continue;
        // The base of golangci-lint's reported path depends on its
        // relative-path-mode (see issuePathCandidates), so match against
        // the plausible bases rather than assuming one.
        let changedFile: ChangedFile | undefined;
        for (const key of issuePathCandidates(deps.workspaceDir, group.root, issue.Pos.Filename)) {
          changedFile = filesByPath.get(key);
          if (changedFile !== undefined) break;
        }
        if (changedFile === undefined) continue;
        if (!changedFile.added_lines.has(issue.Pos.Line)) continue;
        findings.push(buildFinding(changedFile.path, issue));
      }
    }

    return { findings, errors, filesExamined: ranAny ? targetFiles.length : 0 };
  },
};

export interface GoModuleGroup {
  /** Module root, POSIX, relative to the workspace. `.` = repo root. */
  root: string;
  /**
   * Package-dir targets to pass golangci-lint, relative to `root`:
   * `./` for the root package, `./<subdir>` for nested packages.
   */
  dirs: string[];
}

/**
 * Walk up from a file's directory to find the nearest ancestor containing
 * a `go.mod`, bounded at the repo root. Returns that directory (POSIX,
 * relative to the workspace), or `.` when none is found — which preserves
 * the prior behavior for repos with a root `go.mod` (or none at all).
 *
 * Exported for testing; `hasGoMod` is injected so the walk can be tested
 * without touching the filesystem.
 */
export function nearestGoModuleRoot(
  fileDirRel: string,
  hasGoMod: (dirRel: string) => boolean,
): string {
  const parts = fileDirRel === '.' ? [] : fileDirRel.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const dir = parts.slice(0, i).join('/');
    if (hasGoMod(dir)) return dir;
  }
  return '.';
}

/**
 * Group changed .go file paths by their nearest Go module root, with the
 * package-dir targets within each module deduped. Repos with Go in a
 * subdirectory module (e.g. `backend/go.mod`) get a group rooted at
 * `backend` so golangci-lint can run from there; multi-module repos get
 * one group per module.
 *
 * Exported for testing — the module attribution + target derivation is the
 * bit most likely to regress silently (a wrong root/target makes
 * golangci-lint scan the wrong place and every finding drops at the
 * changedFiles lookup).
 */
export function groupByGoModule(
  paths: readonly string[],
  hasGoMod: (dirRel: string) => boolean,
): GoModuleGroup[] {
  const byRoot = new Map<string, Set<string>>();
  for (const p of paths) {
    // git diff paths are POSIX, so use path.posix throughout to avoid
    // backslash segments on Windows runners.
    const fileDir = path.posix.dirname(p);
    const root = nearestGoModuleRoot(fileDir, hasGoMod);
    const rel = fileDir === root ? '' : root === '.' ? fileDir : fileDir.slice(root.length + 1);
    const target = rel === '' ? './' : `./${rel}`;
    let dirs = byRoot.get(root);
    if (dirs === undefined) {
      dirs = new Set<string>();
      byRoot.set(root, dirs);
    }
    dirs.add(target);
  }
  return [...byRoot.entries()].map(([root, dirs]) => ({ root, dirs: [...dirs] }));
}

/**
 * Workspace-relative POSIX keys a golangci-lint `Pos.Filename` might map
 * to, in priority order, for matching against `changedFiles`.
 *
 * The base of a *relative* reported path depends on golangci-lint's
 * `run.relative-path-mode`, which we don't control:
 *   - `wd` / `gomod` → relative to the module root we ran the linter from.
 *   - `cfg` (the v2 DEFAULT) → relative to the config file, which for a
 *     repo-root `.golangci.yml` shared by a subdirectory module is the
 *     repo root, so the path is already workspace-relative.
 *
 * So for a subdirectory module we can't assume one base — we return both
 * interpretations and let the changedFiles lookup pick. Ordering is by the
 * strongest available signal: if the reported path already starts with the
 * module root it's almost certainly already workspace-relative (cfg mode
 * against a repo-root config — the v2 default), so the as-reported key
 * goes first; prepending the module root would double the prefix
 * (`backend/backend/...`) and could mis-attach to a real nested file on a
 * line collision. Otherwise the path is module-relative (wd/gomod), so the
 * module-rooted key goes first — which also avoids a same-basename
 * collision with a root-level file (a reported `main.go` from `backend/`
 * resolves to `backend/main.go` before it could match a changed root
 * `main.go`). Either way the other interpretation stays as a fallback.
 *
 * Absolute paths (`relative-path-mode: abs`) are unambiguous.
 *
 * Exported for testing — this resolution is exactly where the
 * relative-path-mode mismatch silently dropped (or mis-attached) findings.
 */
export function issuePathCandidates(
  workspaceDir: string,
  moduleRoot: string,
  filename: string,
): string[] {
  if (path.isAbsolute(filename)) {
    return [normalizeToolPath(workspaceDir, filename)];
  }
  const posixName = path.posix.normalize(filename.split(path.sep).join('/'));
  if (moduleRoot === '.') {
    return [posixName];
  }
  const moduleRooted = path.posix.normalize(`${moduleRoot}/${posixName}`);
  return posixName.startsWith(`${moduleRoot}/`)
    ? [posixName, moduleRooted]
    : [moduleRooted, posixName];
}

function locateBin(workspaceDir: string): ResolvedBinary {
  // Project-local install first (matches the repo's pinned version /
  // .golangci.yml config). findWorkspaceBinary tries .cmd/.exe variants.
  const ws = findWorkspaceBinary([path.join(workspaceDir, 'bin', 'golangci-lint')]);
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
 *
 * `--show-stats=false` is required on the v2 path: v2 enables stats by
 * default and appends a non-JSON summary ("N issues:" …) to stdout
 * alongside the report, so `JSON.parse` would choke on the trailing text
 * for exactly the v2-with-findings case this fallback exists to handle.
 * The v1 path doesn't need it — `--out-format=json` writes JSON only, and
 * `--show-stats` predates neither reliably nor losslessly across v1
 * minors, so adding it there risks an unknown-flag error that would
 * wrongly trip the fallback.
 */
async function runWithFallback(
  bin: ResolvedBinary,
  dirs: string[],
  deps: ScannerDeps,
  cwd: string,
): Promise<string> {
  const common = ['run', '--issues-exit-code=0', `--timeout=${GOLANGCI_INTERNAL_TIMEOUT}`];
  try {
    return await runCli(bin, [...common, '--out-format=json', ...dirs], deps, cwd);
  } catch (err) {
    const msg = (err as Error).message;
    if (isMissingBinary(msg)) throw err;
    if (looksLikeUnknownFlag(msg)) {
      return runCli(
        bin,
        [...common, '--output.json.path=stdout', '--show-stats=false', ...dirs],
        deps,
        cwd,
      );
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
  cwd: string,
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
      // The module root, not always the workspace root — so `go list`
      // resolves the right go.mod for subdirectory/nested modules.
      cwd,
      env: buildLinterEnv(),
      shell: bin.needsShell,
    };
    const child =
      argsForSpawn === null
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

/**
 * Pull the specific sub-check out of a golangci-lint message when the
 * linter prefixes it — `govet` ("printf: …"), `staticcheck` ("SA1019: …"),
 * `gosec` ("G404: …"), `revive` ("var-naming: …"), etc. golangci-lint's
 * JSON has no dedicated rule-code field (only the coarse `FromLinter`), so
 * this prefix is the one stable, human-meaningful sub-identifier available.
 *
 * Returns '' for the linters that emit a plain sentence with no `code: `
 * prefix (e.g. errcheck's "Error return value of `x` is not checked").
 *
 * Exported for testing.
 */
export function extractGoSubRule(text: string): string {
  // Leading `<token>: ` where token looks like a check id (starts with a
  // letter; letters/digits/._-/ only; bounded length so a stray "Note: "
  // sentence doesn't produce an absurd rule id).
  const match = /^([A-Za-z][A-Za-z0-9._/-]{0,39}):\s/.exec(text);
  return match ? match[1]! : '';
}

export function buildFinding(filePath: string, issue: GolangciIssue): ScanFinding {
  const fromLinter = issue.FromLinter.length > 0 ? issue.FromLinter : 'unknown';
  const severity: Severity = golangSeverity(fromLinter);
  const category: Category = golangCategory(fromLinter);
  const confidence: Confidence = 'high';
  const line = issue.Pos.Line;
  const col = issue.Pos.Column ?? 0;

  // Per-diagnostic discriminator so two distinct diagnostics on the SAME
  // added line survive dedup. The runner drops a finding on EITHER an
  // identical fingerprint OR an identical (file_path, line, rule_id)
  // triple (see scanners/dedup.ts), and `FromLinter` alone is too coarse:
  // govet can emit printf+shadow, errcheck can flag two calls, all on one
  // line. We combine the stable sub-check (when the linter prefixes one)
  // with the column so genuinely different diagnostics differ in BOTH
  // keys, while a true repeat (same sub-check, same column) still
  // collapses. Both parts are stable across runs — unlike the message
  // text — so the rule_id stays usable as an exact ignore-list key.
  const subRule = extractGoSubRule(issue.Text);
  const disc = [subRule, col > 0 ? `c${col}` : ''].filter((p) => p !== '').join('.');
  const ruleSuffix = disc !== '' ? `:${disc}` : '';
  const fingerprint = `${ID}:${fromLinter}${ruleSuffix}:${filePath}:${line}`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${fromLinter}${ruleSuffix}`,
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
