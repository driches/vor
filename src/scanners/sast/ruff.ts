/**
 * Ruff linter module — runs the target repo's ruff (or a globally-installed
 * one) against changed Python files.
 *
 * Activation order:
 *   1. `<workspace>/.venv/bin/ruff` (venv-local install — preferred)
 *   2. `<workspace>/node_modules/.bin/ruff` (rare but possible via @ruff/cli)
 *   3. `ruff` on PATH (system or runner-image install)
 *
 * Returns empty quietly when none of these resolve — many Python repos
 * use other linters and that's not a scanner failure.
 *
 * Severity mapping:
 *   - F-rules (pyflakes/import errors) → 'important' (likely real bugs)
 *   - E9-rules (syntax errors) → 'important'
 *   - All other E/W/etc rules → 'minor' (style + soft warnings)
 *
 * Ruff JSON format docs: https://docs.astral.sh/ruff/configuration/#output-format
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  filterShellSafePaths,
  findWorkspaceBinary,
  normalizeToolPath,
  shellQuoteBinary,
  type LinterModule,
  type LinterRun,
  type ResolvedBinary,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'ruff';
const TIMEOUT_MS = 60_000;
const TARGET_EXTENSIONS = /\.(py|pyi)$/;

interface RuffMessage {
  code: string | null;
  message: string;
  filename: string;
  location: { row: number; column: number };
  end_location?: { row: number; column: number };
  fix?: unknown;
}

export const ruffLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSIONS.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];
    const bin = locateBin(deps.workspaceDir);

    // Shell-injection guard — see eslint.ts for the full rationale. When
    // the binary resolves to a .cmd Windows shim we use shell:true; PR
    // file paths are attacker-controlled, so filter out anything with
    // shell metacharacters before passing to argv.
    const { safe, dropped } = filterShellSafePaths(
      targetFiles.map((f) => f.path),
      bin.needsShell,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `ruff: skipped ${dropped.length} file(s) with shell-unsafe paths (Windows shim mode): ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
      );
    }
    if (safe.length === 0) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, safe, deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Quiet skip when ruff isn't actually installed anywhere
      // resolvable. `locateBin` falls back to the bare name 'ruff' for
      // PATH lookup (now with shell:true on Windows for .cmd shims),
      // so we need the full set of missing-binary signals across
      // platforms. Same enumeration as knip.ts — see the comment there
      // for the per-signal rationale (ENOENT, "not found", cmd.exe's
      // "is not recognized" / exit 9009, POSIX sh exit 127). The
      // 9009/127 exit codes are locale-independent and load-bearing;
      // the English substrings are belt-and-suspenders.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `ruff failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let messages: RuffMessage[];
    try {
      // Ruff's --output-format=json emits an array of message objects.
      messages = JSON.parse(rawOutput) as RuffMessage[];
      if (!Array.isArray(messages)) throw new Error('non-array output');
    } catch (err) {
      errors.push({
        message: `ruff output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const message of messages) {
      const relPath = normalizeToolPath(deps.workspaceDir, message.filename);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(message.location.row)) continue;
      if (message.code === null) continue;
      findings.push(buildFinding(changedFile.path, message, changedFile));
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

function locateBin(workspaceDir: string): ResolvedBinary {
  // Workspace candidates first — venv ruff matches the repo's pinned
  // version and config. Both Unix (`.venv/bin/`) and Windows
  // (`.venv/Scripts/`) layouts are checked, plus the rare `@ruff/cli`
  // npm install at `node_modules/.bin/ruff`. findWorkspaceBinary tries
  // .cmd / .exe variants on each.
  const ws = findWorkspaceBinary([
    path.join(workspaceDir, '.venv', 'bin', 'ruff'),
    path.join(workspaceDir, '.venv', 'Scripts', 'ruff'),
    path.join(workspaceDir, 'node_modules', '.bin', 'ruff'),
  ]);
  if (ws !== null) return ws;
  // PATH-resolved is just 'ruff'. On Windows, global pip installs land
  // as `ruff.cmd` shims that Node's libuv `spawn` with `shell: false`
  // cannot execute — it can only resolve `.exe` for bare names. Force
  // shell:true on Windows so cmd.exe honors PATHEXT and finds the shim.
  // Mirrors the knip.ts PATH-fallback decision and the same Codex P2
  // fix from earlier in this PR. ENOENT here is caught by runCli's
  // error handler and becomes a quiet skip.
  const isWindows = process.platform === 'win32';
  return { path: 'ruff', needsShell: isWindows };
}

function runCli(
  bin: ResolvedBinary,
  files: string[],
  deps: ScannerDeps,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      shellQuoteBinary(bin),
      ['check', '--output-format=json', '--no-cache', '--exit-zero', ...files],
      {
        cwd: deps.workspaceDir,
        env: buildLinterEnv(),
        shell: bin.needsShell,
      },
    );
    // Buffer accumulation — avoids O(n²) string concat on large outputs
    // and UTF-8 corruption across chunk boundaries.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`ruff timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('ruff aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`ruff killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // --exit-zero means ruff returns 0 even with findings. Any non-zero
      // exit is a real error (bad args, config error, missing files).
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`ruff exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // ENOENT (binary not found) is common when PATH lookup falls
      // through — surface as a benign error so the orchestrator can
      // continue.
      reject(err);
    });
  });
}

function buildFinding(
  filePath: string,
  message: RuffMessage,
  changedFile: { added_lines: ReadonlySet<number> },
): ScanFinding {
  const code = message.code ?? 'unknown';
  const severity: Severity = severityFromCode(code);
  const category: Category = categorize(code);
  const confidence: Confidence = 'high';
  const startLine = message.location.row;
  const endLine = message.end_location?.row;
  // Anchor on the START line. Only attach a multi-line range when BOTH
  // endpoints are reviewable — same fix as eslint and semgrep. Pre-fix,
  // a violation starting on an added line but extending into context
  // lines would be silently dropped by the validator.
  const useRange =
    endLine !== undefined &&
    endLine > startLine &&
    changedFile.added_lines.has(endLine);
  // Fingerprint anchors at the line we actually post the comment at —
  // see eslint.ts for the full rationale. Pre-fix this used `startLine`
  // unconditionally, so a useRange finding's fingerprint disagreed with
  // the comment's actual `endLine` anchor, breaking dedup across runs.
  const fingerprint = `${ID}:${code}:${filePath}:${useRange ? endLine : startLine}`;
  const title = renderTitle(code, message.message);
  const description = renderDescription(code, message.message);
  return {
    scanner: 'sast',
    rule_id: `${ID}/${code}`,
    file_path: filePath,
    line: useRange ? endLine : startLine,
    ...(useRange ? { start_line: startLine } : {}),
    severity,
    category,
    title,
    description,
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function severityFromCode(code: string): Severity {
  // F-rules: pyflakes (real errors like undefined names, unused imports).
  // E9: syntax errors. Both signal likely real bugs → 'important'.
  if (code.startsWith('F') || code.startsWith('E9')) return 'important';
  // S-rules: bandit-style security checks (when ruff is configured with them).
  if (code.startsWith('S')) return 'important';
  // Everything else (style E/W/N, complexity C, etc.) → minor.
  return 'minor';
}

function categorize(code: string): Category {
  if (code.startsWith('S')) return 'vulnerability';
  if (code.startsWith('F')) return 'bug';
  if (code.startsWith('B')) return 'bug';
  return 'readability';
}

function renderTitle(code: string, message: string): string {
  const ruleStr = `[${ID}/${code}] `;
  const firstLine = message.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(code: string, message: string): string {
  return `Ruff rule: \`${code}\`.\n\n${message}`;
}
