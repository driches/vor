import { existsSync } from 'node:fs';
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

/**
 * Build the env to pass to spawned linter processes.
 *
 * Security note (Codex PR #21 P1): some of our linters (eslint, ruff,
 * knip) resolve their binary from inside the workspace (e.g.
 * `node_modules/.bin/eslint`). On untrusted PRs that workspace is
 * attacker-controlled — a malicious contributor can add a script at the
 * lookup path and we'll execute it. The full fix would be "never run
 * binaries from the checkout", but for eslint specifically that's the
 * canonical install location (and `npx eslint` has the identical risk),
 * so refusing it would break the action for most TS/JS repos.
 *
 * Defense-in-depth instead: pass an env *allowlist* rather than the full
 * inherited process.env. A malicious binary can still run arbitrary
 * code on the runner (file reads, outbound HTTP, etc.), but it doesn't
 * get GITHUB_TOKEN, ANTHROPIC_API_KEY, ACTIONS_* internals, or any
 * INPUT_* values for free via the environment.
 *
 * Operators on `pull_request_target` (where secrets are exposed to PR
 * code) should treat this action like any other code-execution-on-PR
 * tool and pin the workflow accordingly. Bundled-binary mode (TODO) is
 * the better long-term fix.
 */
const LINTER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CI',
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  'VIRTUAL_ENV',
  'PYTHONPATH',
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_CACHE',
  'FORCE_COLOR',
  'NO_COLOR',
  // Proxy + cert routing — semgrep --config=auto and ruff/knip in
  // corporate CI environments need these to reach package registries.
  // These don't carry application secrets; they configure HTTP transport.
  // Without them, semgrep silently fails to fetch rules in proxied CI.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  // Windows essentials (Codex PR #21 P1). On Windows, both the bare-name
  // PATH lookup (e.g. `spawn('knip')`) and the .cmd-shim shell route
  // (`shell: true`) need these to function:
  //   - PATHEXT: lists which extensions Node/cmd.exe try when resolving
  //     an extensionless command. Without it, `spawn('ruff')` ENOENTs
  //     because Windows can't find `ruff.exe`/`ruff.cmd`.
  //   - SystemRoot, COMSPEC, windir: cmd.exe needs these to load its
  //     own DLLs and locate itself. Stripping them breaks every shell:true
  //     spawn on Windows.
  //   - USERPROFILE, APPDATA, LOCALAPPDATA: npm and Python tools look
  //     here for user-scoped config (.npmrc, ruff cache). Missing them
  //     causes silent fall-through to defaults that may not match the
  //     repo's expected configuration.
  //   - ProgramFiles*: some tools (semgrep on Windows) probe these for
  //     auxiliary binary lookups.
  'PATHEXT',
  'SystemRoot',
  'COMSPEC',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  // Dart / Flutter SDK lookup. `dart analyze` resolves its own SDK
  // libraries via DART_SDK / FLUTTER_ROOT, and reads its package cache
  // from PUB_CACHE / PUB_HOSTED_URL. Stripping these from the spawned
  // env causes dart to ENOENT on its own libraries or fall back to
  // wrong defaults, producing zero findings with no error — a silent
  // false-negative that's hard to diagnose in CI.
  'DART_SDK',
  'FLUTTER_ROOT',
  'FLUTTER_HOME',
  'PUB_CACHE',
  'PUB_HOSTED_URL',
  // Semgrep authentication. Operators using Semgrep Pro authenticate via
  // SEMGREP_APP_TOKEN to access proprietary rule packs, organization
  // policies, and managed configs. Stripping it from the spawn env
  // silently degrades them to the free `--config=auto` ruleset with no
  // warning. This IS a credential — we're trading the env-allowlist
  // boundary for the visibility of Pro coverage. Acceptable because (a)
  // the linter is the legitimate consumer of this token, and (b) the
  // alternative (silent coverage degradation) is worse for the operator.
  'SEMGREP_APP_TOKEN',
];

export function buildLinterEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of LINTER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Windows portability layer for resolving a linter binary that may live
 * in the workspace (e.g. `node_modules/.bin/eslint`, `.venv/bin/ruff`).
 *
 * Two Windows quirks the bare-Unix code missed:
 *   1. npm shims under `node_modules/.bin/` are `.cmd` files on Windows
 *      (eslint.cmd, knip.cmd). Node's child_process.spawn against an
 *      ABSOLUTE path doesn't honor PATHEXT, so a direct spawn of the
 *      no-extension path silently ENOENTs.
 *   2. Python venvs use `.venv/Scripts/` on Windows instead of
 *      `.venv/bin/`.
 *
 * Resolution strategy: walk the candidate list in order; for each
 * candidate, try the bare path, then `${path}.cmd`, then `${path}.exe`.
 * Return the first one that exists, plus a `needsShell` flag set when
 * the resolved file is `.cmd` or `.bat` (those require cmd.exe and
 * can't be spawned directly on Windows).
 *
 * Returns null when nothing resolves — caller falls back to PATH (which
 * DOES honor PATHEXT for bare-name spawn) or quiet-skips.
 */
export interface ResolvedBinary {
  path: string;
  needsShell: boolean;
}

/**
 * Filenames that are unsafe to pass to a shell. On Windows, when we spawn
 * a `.cmd` shim we have to use `shell: true` (Node can't execute .cmd
 * directly), and cmd.exe interprets these characters in the argument
 * list — an attacker who can choose a filename can inject commands.
 * Bash/POSIX shells interpret a similar set.
 *
 * Anything in this character class gets refused before being added to a
 * spawn arg list when shell is enabled. Tab/newline are included because
 * `git diff` filenames can technically contain them.
 */
const SHELL_UNSAFE_FILENAME_CHARS = /[&|;<>()$`"'\\!*?~%^\t\n\r]/;

/**
 * Check whether a path is safe to pass to a shell-enabled spawn.
 *
 * Used by linter modules whose binary resolves to a `.cmd` Windows shim
 * (eslint, ruff, knip) where `findWorkspaceBinary` sets `needsShell: true`
 * — in that mode, file paths flow through `cmd.exe /c` which parses
 * metacharacters. Filtering at the args boundary means an attacker can't
 * inject by naming a file `foo.ts & whoami > c:\\pwned`.
 *
 * Returns true for safe paths (letters, digits, `._-/`, plus localised
 * unicode), false for paths containing any of the metacharacters in
 * SHELL_UNSAFE_FILENAME_CHARS.
 */
export function isShellSafePath(p: string): boolean {
  return !SHELL_UNSAFE_FILENAME_CHARS.test(p);
}

/**
 * Quote an executable path for shell-mode spawn when needed.
 *
 * With `shell: true`, Node passes the command and its argv to cmd.exe (on
 * Windows) or `/bin/sh -c` (on Unix) as a single command-line string. If
 * the executable path contains a space (e.g. `C:\Users\My User\repo\node_modules\.bin\eslint.cmd`),
 * the shell splits on the space and tries to execute the first token,
 * failing the spawn. Wrap the path in double quotes for shell mode so the
 * shell treats it as one token. With `shell: false`, Node passes argv
 * directly to execve without shell parsing, so no quoting is needed.
 *
 * Workspace paths are produced by `findWorkspaceBinary`, which only
 * returns paths that `existsSync` confirmed — so the path is well-formed
 * and won't contain a literal `"` (Windows filenames can't contain that
 * character; Unix filenames technically can but the wrapped path would
 * still work as long as the inner quote isn't escaped by something
 * earlier in the chain).
 */
export function shellQuoteBinary(bin: ResolvedBinary): string {
  return bin.needsShell ? `"${bin.path}"` : bin.path;
}

/**
 * Filter a path list and return entries safe to pass to spawn's argv.
 *
 * Two threat classes the PR-filename attack surface produces:
 *
 *   1. **Option-confusion** (both shell modes). A file named `--evil=value`
 *      reaches the linter's CLI parser as a flag instead of a file
 *      argument. ESLint, ruff, semgrep, dart, actionlint all accept
 *      arbitrary flags at the same position files appear — at best the
 *      linter silently skips real files; at worst the attacker changes
 *      output destination or rule loading. Reject all leading-dash paths.
 *
 *   2. **Shell-token splitting & injection** (needsShell=true only). When
 *      `shell: true`, Node concatenates argv into one command line that
 *      cmd.exe (or sh) re-tokenizes on whitespace and metacharacters.
 *      A path `foo bar.ts` becomes two tokens. A path `foo & whoami` is
 *      command injection. We DROP metachar paths and WRAP the survivors
 *      in double quotes so cmd.exe treats them as single tokens. The
 *      metachar regex already excludes `"` and `\\`, so the simple wrap
 *      can't be escaped from.
 *
 * Returns both the cleaned arg list (in the form spawn should receive)
 * AND the rejected raw paths so the caller can log a warning.
 */
export function filterShellSafePaths(
  paths: readonly string[],
  needsShell: boolean,
): { safe: string[]; dropped: string[] } {
  const safe: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) {
    if (p.length === 0) {
      dropped.push(p);
      continue;
    }
    // Option-confusion guard. A real source file in a repo never starts
    // with `-`; if a PR adds one, refuse to feed it to the linter rather
    // than risk it being parsed as a CLI flag. Applies in BOTH shell modes.
    if (p.startsWith('-')) {
      dropped.push(p);
      continue;
    }
    if (needsShell) {
      // shell:true: drop paths with cmd.exe / POSIX-shell metachars, and
      // quote everything else so internal spaces don't split into tokens.
      if (!isShellSafePath(p)) {
        dropped.push(p);
        continue;
      }
      safe.push(`"${p}"`);
    } else {
      // shell:false: Node passes argv directly to execve; no tokenizing
      // happens. The leading-dash filter above is the only thing needed
      // and the path passes through unmodified.
      safe.push(p);
    }
  }
  return { safe, dropped };
}

export function findWorkspaceBinary(
  candidates: readonly string[],
): ResolvedBinary | null {
  // Try the no-extension form first (Unix), then Windows shim/exe forms.
  // Most repos resolve at the first candidate; the extension fallbacks
  // only kick in on Windows.
  const exts = ['', '.cmd', '.exe', '.bat'];
  for (const base of candidates) {
    for (const ext of exts) {
      const full = base + ext;
      if (existsSync(full)) {
        return {
          path: full,
          needsShell: ext === '.cmd' || ext === '.bat',
        };
      }
    }
  }
  return null;
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
