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
 * `severity: 1` (warning) → 'minor'. Rule-specific tuning is a v2.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import type { LinterModule, LinterRun } from './linter.js';

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
    const bin = path.join(deps.workspaceDir, 'node_modules', '.bin', 'eslint');
    if (!existsSync(bin)) {
      return { findings: [], errors: [], filesExamined: 0 };
    }

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, targetFiles.map((f) => f.path), deps);
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
      const relPath = path.relative(deps.workspaceDir, fileResult.filePath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const message of fileResult.messages) {
        if (!changedFile.added_lines.has(message.line)) continue;
        if (message.ruleId === null) continue;
        findings.push(buildFinding(changedFile.path, message));
      }
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

function runCli(bin: string, files: string[], deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['--format', 'json', '--no-error-on-unmatched-pattern', ...files],
      {
        cwd: deps.workspaceDir,
        env: { PATH: process.env.PATH ?? '' },
      },
    );
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`eslint timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf-8');
    });
    deps.signal.addEventListener('abort', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('eslint aborted'));
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // 0 = clean, 1 = findings (normal), >1 = config/runtime error.
      if (code !== null && code > 1) {
        reject(new Error(`eslint exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
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

function buildFinding(filePath: string, message: EslintMessage): ScanFinding {
  const severity: Severity = message.severity === 2 ? 'important' : 'minor';
  const category: Category = categorize(message.ruleId ?? 'unknown');
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${message.ruleId}:${filePath}:${message.line}`;
  const title = renderTitle(message);
  const description = renderDescription(message);
  return {
    scanner: 'sast',
    rule_id: `${ID}/${message.ruleId ?? 'unknown'}`,
    file_path: filePath,
    line: message.line,
    ...(message.endLine !== undefined && message.endLine > message.line
      ? { start_line: message.line, line: message.endLine }
      : {}),
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
  if (ruleId.startsWith('@typescript-eslint/')) return 'bug';
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
