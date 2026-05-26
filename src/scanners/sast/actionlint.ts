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
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import type { LinterModule, LinterRun } from './linter.js';

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

    let rawOutput: string;
    try {
      rawOutput = await runCli(targetFiles.map((f) => f.path), deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Missing binary → quiet skip. Anything else → record error.
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `actionlint failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let messages: ActionlintError[];
    try {
      messages = JSON.parse(rawOutput) as ActionlintError[];
      if (!Array.isArray(messages)) throw new Error('non-array output');
    } catch (err) {
      errors.push({
        message: `actionlint output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const findings: ScanFinding[] = [];
    for (const message of messages) {
      const relPath = path.relative(deps.workspaceDir, message.filepath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
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
      reject(new Error(`actionlint timed out after ${TIMEOUT_MS}ms`));
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
      reject(new Error('actionlint aborted'));
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // actionlint: 0 = clean, 1 = findings, >1 = runtime/config error.
      if (code !== null && code > 1) {
        reject(new Error(`actionlint exited ${code}: ${stderr.trim().slice(0, 500)}`));
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
