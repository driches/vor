/**
 * actionlint linter module — runs `actionlint` against changed GitHub
 * Actions workflow YAML files.
 *
 * Activation: only when the diff touches `.github/workflows/*.yml` or
 * `*.yaml`. Requires `actionlint` on PATH.
 *
 * actionlint catches: expression syntax errors, invalid runner labels,
 * missing required action inputs, glob-pattern typos, shellcheck-style
 * issues in `run:` scripts (when shellcheck is also available), and many
 * GitHub-specific configuration mistakes that ESLint/etc don't know
 * about. These are exactly the kind of "we have a config-format expert
 * for that" findings that should never have spent Sonnet turns.
 *
 * Output format: actionlint -format '{{json .}}' emits a single JSON
 * array of error objects with `kind`, `message`, `filepath`, `line`,
 * `column`. Documented at https://github.com/rhysd/actionlint/blob/main/docs/usage.md#format-option
 *
 * Severity mapping: actionlint doesn't grade severity itself. Schema/
 * syntax errors map to 'important' (the workflow probably doesn't run);
 * expression and shellcheck integrations map to 'minor'.
 */
import { spawn } from 'node:child_process';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  filterShellSafePaths,
  normalizeToolPath,
  type LinterModule,
  type LinterRun,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'actionlint';
const TIMEOUT_MS = 30_000;
const WORKFLOW_PATH_RE = /^\.github\/workflows\/.+\.ya?ml$/;

interface ActionlintError {
  message: string;
  filepath: string;
  line: number;
  column?: number;
  kind: string;
  /** Optional snippet shown in actionlint's terminal output. We ignore it. */
  snippet?: string;
}

export const actionlintLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => WORKFLOW_PATH_RE.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];

    // Option-confusion guard. A workflow file named `-foo.yml` would be
    // parsed by actionlint as a flag. The WORKFLOW_PATH_RE on .applies()
    // requires `.github/workflows/...` so the realistic attack surface is
    // narrow, but we filter for consistency with the other linters.
    // shell:false → only the leading-dash filter applies.
    const { safe, dropped } = filterShellSafePaths(
      targetFiles.map((f) => f.path),
      false,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `actionlint: skipped ${dropped.length} file(s) with leading-dash names: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
      );
    }
    if (safe.length === 0) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runCli(safe, deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Match knip/ruff/semgrep/dart: `command not found` (POSIX shell
      // prefix) is the specific signal — bare `not found` would also
      // match real actionlint errors like "workflow file not found" or
      // "action not found", silently swallowing them. Exit codes
      // 9009/127 cover Windows cmd.exe and POSIX sh missing-command.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('command not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `actionlint failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let messages: ActionlintError[];
    try {
      // actionlint is Go, and Go's `json.Marshal` serializes a nil slice
      // as `null` rather than `[]`. So a clean workflow run exits 0 with
      // stdout `null`. `JSON.parse("null")` succeeds but returns null,
      // which would fail Array.isArray and push a spurious parse error
      // for every clean run. Coalesce to empty array.
      const parsed = JSON.parse(rawOutput) as ActionlintError[] | null;
      messages = parsed ?? [];
      if (!Array.isArray(messages)) throw new Error('non-array output');
    } catch (err) {
      errors.push({
        message: `actionlint output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const message of messages) {
      const relPath = normalizeToolPath(deps.workspaceDir, message.filepath);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(message.line)) continue;
      findings.push(buildFinding(changedFile.path, message));
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

function runCli(files: string[], deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    // -no-color avoids ANSI sequences leaking into the JSON. -format
    // '{{json .}}' is actionlint's Go-template-driven JSON output.
    const child = spawn(
      'actionlint',
      ['-no-color', '-format', '{{json .}}', ...files],
      {
        cwd: deps.workspaceDir,
        env: buildLinterEnv(),
      },
    );
    // Collect chunks as Buffers and concatenate once at close time. The
    // pre-fix `stdout += chunk.toString('utf-8')` pattern is O(n²) on long
    // outputs AND can corrupt UTF-8 sequences that straddle a chunk
    // boundary (each chunk gets decoded independently). Buffer.concat
    // preserves byte boundaries; a single trailing toString decodes
    // correctly regardless of where chunks happened to split.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`actionlint timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('actionlint aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`actionlint killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // actionlint: 0 = clean, 1 = findings, >1 = runtime/config error.
      if (code > 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`actionlint exited ${code}: ${stderr.trim().slice(0, 500)}`));
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

function buildFinding(filePath: string, message: ActionlintError): ScanFinding {
  const severity: Severity = severityFromKind(message.kind);
  const category: Category = categorize(message.kind);
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${message.kind}:${filePath}:${message.line}`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${message.kind}`,
    file_path: filePath,
    line: message.line,
    severity,
    category,
    title: renderTitle(message),
    description: renderDescription(message),
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function severityFromKind(kind: string): Severity {
  // Schema/syntax errors mean the workflow likely won't run as intended.
  // Expression and shellcheck findings are usually subtler.
  if (
    kind === 'syntax-check' ||
    kind === 'workflow-schema' ||
    kind === 'workflow-call'
  ) {
    return 'important';
  }
  return 'minor';
}

function categorize(kind: string): Category {
  if (kind === 'expression' || kind === 'syntax-check') return 'bug';
  if (kind === 'shellcheck') return 'bug';
  return 'readability';
}

function renderTitle(message: ActionlintError): string {
  const ruleStr = `[${ID}/${message.kind}] `;
  const firstLine = message.message.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(message: ActionlintError): string {
  return `actionlint check: \`${message.kind}\`.\n\n${message.message}`;
}
