/**
 * Dart linter module — runs `dart analyze` against changed .dart files.
 *
 * Activation: requires `dart` on PATH (Flutter SDK or standalone Dart
 * install). Returns empty quietly when missing.
 *
 * Output format: dart analyze --format=machine emits pipe-delimited
 * lines, one per finding:
 *   SEVERITY|TYPE|RULE_NAME|FILE|LINE|COLUMN|LENGTH|MESSAGE
 * Example:
 *   INFO|LINT|prefer_const_constructors|lib/foo.dart|42|7|5|Prefer const ...
 *
 * The MACHINE format is documented at
 * https://dart.dev/tools/dart-analyze#machine-readable-output and is the
 * stable contract for scripting; the human format is for terminal use.
 *
 * Severity mapping (dart's own SEVERITY column):
 *   - ERROR → 'important' (compile errors, runtime crashes)
 *   - WARNING → 'minor' (likely bugs but not blocking)
 *   - INFO → 'nit' (style + recommendations)
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

const ID = 'dart';
const TIMEOUT_MS = 90_000;
const TARGET_EXTENSION = /\.dart$/;

interface DartFinding {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  type: string;
  ruleName: string;
  filePath: string;
  line: number;
  column: number;
  length: number;
  message: string;
}

export const dartLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSION.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];

    // Option-confusion guard. A PR file named `--fatal-infos`,
    // `--format=json`, etc. would be parsed by `dart analyze` as a flag
    // (changing exit codes or breaking the machine-format parser). shell:false
    // here so only the leading-dash filter applies.
    const { safe, dropped } = filterShellSafePaths(
      targetFiles.map((f) => f.path),
      false,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `dart: skipped ${dropped.length} file(s) with leading-dash names: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
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
      // Match knip/ruff/semgrep: `command not found` (POSIX shell prefix)
      // is the specific signal — bare `not found` would also match real
      // dart errors like "Analysis target not found" or "Library not
      // found", silently swallowing them. Exit codes 9009/127 cover
      // Windows cmd.exe and POSIX sh missing-command cases.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('command not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `dart analyze failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const line of rawOutput.split('\n')) {
      const parsed = parseDartLine(line);
      if (parsed === null) continue;
      const relPath = normalizeToolPath(deps.workspaceDir, parsed.filePath);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(parsed.line)) continue;
      findings.push(buildFinding(changedFile.path, parsed));
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

/**
 * Parse one line of dart analyze --format=machine output. Lines that
 * don't fit the 8-pipe schema (header lines, empty lines, the trailing
 * "N issues found" status line) return null.
 *
 * Exported for testing — the parsing has more invariants than its size
 * suggests (8-pipe schema, message tails containing `|`, severity
 * validation, numeric coercion), and a regression here drops every dart
 * finding silently.
 */
export function parseDartLine(line: string): DartFinding | null {
  if (line.trim().length === 0) return null;
  const parts = line.split('|');
  if (parts.length < 8) return null;
  const [severity, type, ruleName, filePath, lineStr, columnStr, lengthStr, ...messageParts] = parts;
  if (
    severity !== 'ERROR' &&
    severity !== 'WARNING' &&
    severity !== 'INFO'
  ) {
    return null;
  }
  const lineNum = Number.parseInt(lineStr ?? '', 10);
  if (!Number.isFinite(lineNum) || lineNum <= 0) return null;
  const columnNum = Number.parseInt(columnStr ?? '', 10);
  const lengthNum = Number.parseInt(lengthStr ?? '', 10);
  return {
    severity,
    type: type ?? '',
    ruleName: ruleName ?? '',
    filePath: filePath ?? '',
    line: lineNum,
    column: Number.isFinite(columnNum) ? columnNum : 0,
    length: Number.isFinite(lengthNum) ? lengthNum : 0,
    // Message can contain `|` so re-join the tail.
    message: messageParts.join('|'),
  };
}

function runCli(files: string[], deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'dart',
      ['analyze', '--format=machine', ...files],
      {
        cwd: deps.workspaceDir,
        env: buildLinterEnv(),
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
      reject(new Error(`dart analyze timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('dart analyze aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`dart analyze killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      // dart analyze: 0 = no issues, 1 = info-only, 2 = warnings, 3 = errors.
      // All four are "ran successfully and reported issues" — only treat
      // codes >3 as runtime errors.
      if (code > 3) {
        reject(new Error(`dart analyze exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      // `dart analyze --format=machine` actually emits its findings on
      // STDERR — stdout is typically empty. We concatenate both defensively
      // so future SDK versions that route output differently don't silently
      // produce zero findings. The parseDartLine filter accepts only
      // pipe-delimited lines that match the schema, so any non-finding
      // content from either stream is harmlessly skipped.
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      resolve(stderr + '\n' + stdout);
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function buildFinding(filePath: string, finding: DartFinding): ScanFinding {
  const severity: Severity = severityFromDart(finding.severity);
  const category: Category = categorize(finding.type, finding.ruleName);
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${finding.ruleName}:${filePath}:${finding.line}`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${finding.ruleName}`,
    file_path: filePath,
    line: finding.line,
    severity,
    category,
    title: renderTitle(finding),
    description: renderDescription(finding),
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function severityFromDart(s: DartFinding['severity']): Severity {
  if (s === 'ERROR') return 'important';
  if (s === 'WARNING') return 'minor';
  return 'nit';
}

function categorize(type: string, ruleName: string): Category {
  // type is one of ERROR | LINT | HINT. ERRORs from the analyzer are real
  // bugs. LINT/HINT are style/recommendations.
  if (type === 'ERROR') return 'bug';
  if (ruleName.includes('async') || ruleName.includes('await')) return 'bug';
  return 'readability';
}

function renderTitle(finding: DartFinding): string {
  const ruleStr = `[${ID}/${finding.ruleName}] `;
  const firstLine = finding.message.split('\n')[0]!;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(finding: DartFinding): string {
  return `Dart analyzer rule: \`${finding.ruleName}\` (${finding.type.toLowerCase()}).\n\n${finding.message}`;
}
