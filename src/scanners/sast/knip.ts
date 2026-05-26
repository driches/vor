/**
 * Knip linter module — detects unused exports, unused dependencies, and
 * unused files in TS/JS projects.
 *
 * Why this exists: "is X unused?" was identified as ~10% of the agent's
 * tool-loop overhead. Knip answers it deterministically via the TS
 * compiler's symbol table — no LLM judgement needed. Findings the agent
 * would have spent 3-5 turns verifying ("grep for callers, read 2 files,
 * conclude unused") are produced in one knip invocation at zero token
 * cost.
 *
 * Activation:
 *   1. `<workspace>/node_modules/.bin/knip` (preferred — repo's pinned version)
 *   2. PATH-resolved `knip` (system or runner-image install)
 *
 * Quiet skip when neither resolves — most repos don't run knip and
 * that's not a code-review failure.
 *
 * Output format: knip --reporter json emits:
 *   { files: [...], dependencies: [...], exports: { "src/foo.ts": [{name, line, col, type}, ...] }, ... }
 * We focus on `exports` (the most actionable category for PR review) and
 * filter to lines this PR added.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  findWorkspaceBinary,
  normalizeToolPath,
  type LinterModule,
  type LinterRun,
  type ResolvedBinary,
} from './linter.js';

const ID = 'knip';
const TIMEOUT_MS = 120_000;
const TARGET_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Subset of knip's JSON shape we actually read. The real schema is much
 * richer (issues by category, severity ranks, etc.); we depend only on
 * fields needed to attribute a finding to a line.
 *
 * Modern knip (`--reporter json`) emits:
 *   { files: [...], issues: [{ file, exports: [...], types: [...], duplicates: [...], ... }, ...] }
 * Each `issues[]` entry is one file. We pull exports/types/duplicates per
 * entry. Older knip versions used flat top-level maps (kept as a fallback
 * in case CI is on a pinned older version).
 */
interface KnipOutput {
  issues?: KnipFileIssues[];
  // Legacy flat-map shape — kept as a fallback for older knip versions.
  exports?: Record<string, KnipExportIssue[]>;
  types?: Record<string, KnipExportIssue[]>;
  duplicates?: Record<string, KnipDuplicateIssue[]>;
}

interface KnipFileIssues {
  file: string;
  exports?: KnipExportIssue[];
  types?: KnipExportIssue[];
  duplicates?: KnipDuplicateIssue[];
}

interface KnipExportIssue {
  name: string;
  line: number;
  col?: number;
  /** Knip's category: 'function' | 'type' | 'class' | 'enum' | etc. */
  type?: string;
}

interface KnipDuplicateIssue {
  name: string;
  line: number;
  col?: number;
}

export const knipLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSIONS.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];
    const bin = locateBin(deps.workspaceDir);

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, deps);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `knip failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let output: KnipOutput;
    try {
      output = JSON.parse(rawOutput) as KnipOutput;
    } catch (err) {
      errors.push({
        message: `knip output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    const findings: ScanFinding[] = [];

    // Modern format — `issues[]` array of per-file objects. Each entry has
    // a `file` field plus exports/types/duplicates arrays.
    for (const entry of output.issues ?? []) {
      const relPath = normalizeToolPath(deps.workspaceDir, entry.file);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const issue of entry.exports ?? []) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildExportFinding(changedFile.path, issue, 'export'));
      }
      for (const issue of entry.types ?? []) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildExportFinding(changedFile.path, issue, 'type'));
      }
      for (const issue of entry.duplicates ?? []) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildDuplicateFinding(changedFile.path, issue));
      }
    }

    // Legacy fallback — older knip versions used flat top-level maps
    // (`exports`/`types`/`duplicates` at the root, keyed by file path).
    // Most current installs won't hit these loops, but keeping them costs
    // nothing and protects pinned-version CI environments.
    for (const [filePath, issues] of Object.entries(output.exports ?? {})) {
      const relPath = normalizeToolPath(deps.workspaceDir, filePath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const issue of issues) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildExportFinding(changedFile.path, issue, 'export'));
      }
    }
    for (const [filePath, issues] of Object.entries(output.types ?? {})) {
      const relPath = normalizeToolPath(deps.workspaceDir, filePath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const issue of issues) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildExportFinding(changedFile.path, issue, 'type'));
      }
    }
    for (const [filePath, issues] of Object.entries(output.duplicates ?? {})) {
      const relPath = normalizeToolPath(deps.workspaceDir, filePath);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      for (const issue of issues) {
        if (!changedFile.added_lines.has(issue.line)) continue;
        findings.push(buildDuplicateFinding(changedFile.path, issue));
      }
    }

    return { findings, errors, filesExamined: targetFiles.length };
  },
};

function locateBin(workspaceDir: string): ResolvedBinary {
  // node_modules/.bin/knip on Unix; npm shims at knip.cmd on Windows
  // (findWorkspaceBinary tries .cmd / .exe variants automatically).
  const ws = findWorkspaceBinary([
    path.join(workspaceDir, 'node_modules', '.bin', 'knip'),
  ]);
  if (ws !== null) return ws;
  // PATH lookup. On Windows, global npm installs land as `knip.cmd` shims —
  // Node's libuv `spawn` with `shell: false` only resolves `.exe` for bare
  // names; it cannot execute `.cmd`/`.bat` directly and ENOENTs silently.
  // Force shell:true on Windows so cmd.exe honors PATHEXT and finds the
  // shim. No file paths are passed in argv (we run `knip --reporter json`
  // with no file targets), so the shell:true path has no filename-driven
  // injection surface here — but if that ever changes, filterShellSafePaths
  // is available the same way ruff/eslint use it.
  const isWindows = process.platform === 'win32';
  return { path: 'knip', needsShell: isWindows };
}

function runCli(bin: ResolvedBinary, deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    // --reporter json is the documented machine-readable format. We run
    // it across the whole repo (knip's analysis IS whole-project — you
    // can't reliably detect unused exports from a partial file list).
    // The filter to PR-added lines happens in the orchestrator above.
    const child = spawn(bin.path, ['--reporter', 'json'], {
      cwd: deps.workspaceDir,
      env: buildLinterEnv(),
      shell: bin.needsShell,
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`knip timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf-8');
    });
    deps.signal.addEventListener(
      'abort',
      () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('knip aborted'));
      },
      { once: true },
    );
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Knip exits non-zero when it has findings. 1 = findings, >1 = config/runtime error.
      if (code !== null && code > 1) {
        reject(new Error(`knip exited ${code}: ${stderr.trim().slice(0, 500)}`));
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

function buildExportFinding(
  filePath: string,
  issue: KnipExportIssue,
  kind: 'export' | 'type',
): ScanFinding {
  const ruleId = kind === 'type' ? 'unused-type' : 'unused-export';
  const severity: Severity = 'minor';
  const category: Category = 'readability';
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${ruleId}:${filePath}:${issue.line}:${issue.name}`;
  const what =
    kind === 'type'
      ? `Type \`${issue.name}\` is exported but unused across the project.`
      : `${capitalize(issue.type ?? 'export')} \`${issue.name}\` is exported but unused across the project.`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${ruleId}`,
    file_path: filePath,
    line: issue.line,
    severity,
    category,
    title: `[${ID}/${ruleId}] ${truncate(what, 100)}`,
    description: `${what}\n\nKnip detects this via whole-project analysis. If \`${issue.name}\` is intended as part of the public API, add it to your knip config's \`entry\` or \`ignoreExportsUsedInFile\`.`,
    suggestion: kind === 'type'
      ? `// Remove the unused type export, or move \`${issue.name}\` to a non-exported declaration.`
      : `// Remove the unused export, or move \`${issue.name}\` to a non-exported declaration if it's only used internally.`,
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function buildDuplicateFinding(
  filePath: string,
  issue: KnipDuplicateIssue,
): ScanFinding {
  const ruleId = 'duplicate-export';
  const severity: Severity = 'important';
  const category: Category = 'bug';
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${ruleId}:${filePath}:${issue.line}:${issue.name}`;
  const what = `\`${issue.name}\` is exported from multiple files — consumers may import the wrong one.`;
  return {
    scanner: 'sast',
    rule_id: `${ID}/${ruleId}`,
    file_path: filePath,
    line: issue.line,
    severity,
    category,
    title: `[${ID}/${ruleId}] ${truncate(what, 100)}`,
    description: `${what}\n\nKnip detected this duplicate export via whole-project analysis. Pick a canonical home for the symbol and remove the others, or re-export from one location.`,
    confidence,
    evidence: { kind: 'sast', cwe: [] },
    fingerprint,
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}
