/**
 * ESLint linter module — runs the target repo's own ESLint config against
 * changed TS/JS files.
 *
 * Activation: requires `node_modules/.bin/eslint` in the workspace.
 * GitHub Actions workflows that `npm ci` before the code-review step have
 * this; bare checkouts don't. When absent, returns empty quietly — not a
 * scanner error.
 *
 * Severity mapping: ESLint `severity: 2` (error) → 'important',
 * `severity: 1` (warning) → 'minor', `severity: 0` (off — appears in
 * output for `--report-unused-disable-directives` and disabled-rule
 * messages) → 'nit'. Rule-specific tuning is a v2.
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
  type LinterModule,
  type LinterRun,
  type ResolvedBinary,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'eslint';
const TIMEOUT_MS = 60_000;
const TARGET_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

interface EslintMessage {
  ruleId: string | null;
  severity: 0 | 1 | 2;
  message: string;
  line: number;
  endLine?: number;
  column?: number;
}

export const eslintLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSIONS.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];
    const bin = findWorkspaceBinary([
      path.join(deps.workspaceDir, 'node_modules', '.bin', 'eslint'),
    ]);
    if (bin === null) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    // When the resolved binary is a Windows .cmd shim, spawn uses
    // shell:true and cmd.exe parses metacharacters in the argument list.
    // Filenames come from the PR diff (attacker-controlled), so we filter
    // shell-unsafe paths out BEFORE building the argv. shell:false runs
    // (Unix, Windows .exe) bypass this filter — execve doesn't parse args.
    const { safe, dropped } = filterShellSafePaths(
      targetFiles.map((f) => f.path),
      bin.needsShell,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `eslint: skipped ${dropped.length} file(s) with shell-unsafe paths (Windows shim mode): ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
      );
    }
    if (safe.length === 0) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, safe, deps);
    } catch (err) {
      errors.push({ message: `eslint failed: ${(err as Error).message}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let results: EslintResult[];
    try {
      results = JSON.parse(rawOutput) as EslintResult[];
      if (!Array.isArray(results)) throw new Error('non-array output');
    } catch (err) {
      errors.push({
        message: `eslint output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const findings: ScanFinding[] = [];
    for (const fileResult of results) {
      const relPath = normalizeToolPath(deps.workspaceDir, fileResult.filePath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const message of fileResult.messages) {
        if (!changedFile.added_lines.has(message.line)) continue;
        if (message.ruleId === null) continue;
        findings.push(buildFinding(changedFile.path, message, changedFile));
      }
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

function runCli(bin: ResolvedBinary, files: string[], deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin.path,
      ['--format', 'json', '--no-error-on-unmatched-pattern', ...files],
      {
        cwd: deps.workspaceDir,
        // Allowlisted env — see buildLinterEnv() / LINTER_ENV_ALLOWLIST
        // for the rationale. Stripping secrets out of the spawned
        // process limits exfiltration even when a malicious workspace
        // binary runs.
        env: buildLinterEnv(),
        // Windows npm shims (.cmd / .bat) need cmd.exe to execute —
        // findWorkspaceBinary sets needsShell when the resolved file is
        // one of those. shell:true is otherwise off (filenames here come
        // from npm conventions, not user input, so the shell-injection
        // surface is bounded — but defense in depth says don't enable
        // shell unless required).
        shell: bin.needsShell,
      },
    );
    // Collect chunks as Buffers; concatenate once at close. Avoids the
    // O(n²) string-concat copy on large outputs and prevents UTF-8
    // corruption when a multi-byte sequence straddles a chunk boundary.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`eslint timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('eslint aborted'));
      },
      // { once: true } so the listener is dropped on every normal
      // completion — `deps.signal` is the long-lived orchestrator
      // signal shared across all linters, and without { once } each
      // runCli would leak a listener for the lifetime of the scan run.
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // code === null means the OS killed the process (OOM killer, runner
      // shutdown, etc.) — stdout is likely truncated, so reject with a
      // clear signal message rather than falling through to resolve and
      // letting JSON.parse blow up with "Unexpected end of JSON input".
      if (code === null) {
        reject(new Error(`eslint killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // 0 = clean, 1 = findings (normal), >1 = config/runtime error.
      if (code > 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`eslint exited ${code}: ${stderr.trim().slice(0, 500)}`));
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

function buildFinding(
  filePath: string,
  message: EslintMessage,
  changedFile: { added_lines: ReadonlySet<number> },
): ScanFinding {
  // Tri-state mapping. Pre-fix the comparison was binary (=== 2 ? ... : 'minor')
  // which silently demoted severity:0 messages (typically from
  // --report-unused-disable-directives) to 'minor' findings — a false
  // positive vector that erodes review-noise trust.
  const severity: Severity =
    message.severity === 2 ? 'important' : message.severity === 1 ? 'minor' : 'nit';
  const category: Category = categorize(message.ruleId ?? 'unknown');
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${message.ruleId}:${filePath}:${message.line}`;
  const title = renderTitle(message);
  const description = renderDescription(message);
  // Anchor the finding to the START line (the line ESLint actually
  // emitted). Pre-fix, we overwrote `line` with `endLine` when both
  // were present — but the validator requires both endpoints to be
  // reviewable, so a violation spanning into a non-added line would
  // get silently dropped even though the start line is a valid comment
  // target. Only attach a multi-line range when BOTH endpoints are in
  // `added_lines`; otherwise post on the start line as a single-line
  // comment.
  const endLine = message.endLine;
  const useRange =
    endLine !== undefined &&
    endLine > message.line &&
    changedFile.added_lines.has(endLine);
  return {
    scanner: 'sast',
    rule_id: `${ID}/${message.ruleId ?? 'unknown'}`,
    file_path: filePath,
    line: useRange ? endLine : message.line,
    ...(useRange ? { start_line: message.line } : {}),
    severity,
    category,
    title,
    description,
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function categorize(ruleId: string): Category {
  if (
    ruleId.startsWith('security/') ||
    ruleId.includes('xss') ||
    ruleId.includes('injection')
  ) {
    return 'vulnerability';
  }
  if (ruleId.includes('unused')) return 'readability';
  if (
    ruleId.includes('no-floating-promises') ||
    ruleId.includes('no-misused-promises') ||
    ruleId.includes('await-thenable')
  ) {
    return 'bug';
  }
  // Don't catch-all @typescript-eslint/* to 'bug' — most of them are
  // style/type rules (no-explicit-any, explicit-function-return-type,
  // naming-convention) where 'readability' is the honest category. The
  // small set of @typescript-eslint promise rules that ARE bug-shaped
  // are matched above this line.
  return 'readability';
}

function renderTitle(message: EslintMessage): string {
  const ruleStr = message.ruleId !== null ? `[${ID}/${message.ruleId}] ` : '';
  const firstLine = message.message.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(message: EslintMessage): string {
  const ruleStr =
    message.ruleId !== null
      ? `ESLint rule: \`${message.ruleId}\`.`
      : 'Reported by ESLint.';
  return `${ruleStr}\n\n${message.message}`;
}
