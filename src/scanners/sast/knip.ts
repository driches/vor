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
  // Per knip's JSON reporter source
  // (packages/knip/src/reporters/json.ts), duplicates is
  // `Array<Array<JSONReportItem>>` — an OUTER array of duplicate-groups,
  // where each inner array is the set of symbols that share the
  // duplication. Pre-fix this interface was `KnipDuplicateIssue[]`, so
  // the parsing loop accessed `issue.line` on what was actually the
  // inner array — every duplicate finding silently dropped.
  duplicates?: KnipDuplicateIssue[][];
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
  // Optional in knip's schema — JSONReportItem.line is nullable. The
  // parsing loop skips entries without a line since we can't pin them
  // to a PR-added line.
  line?: number;
  col?: number;
}

export const knipLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => TARGET_EXTENSIONS.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, _targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    // `_targetFiles` is unused: knip runs whole-project (no per-file argv),
    // and the per-file filter is applied via `deps.changedFiles` below.
    const errors: ScanError[] = [];
    const bin = locateBin(deps.workspaceDir);

    let rawOutput: string;
    try {
      rawOutput = await runCli(bin, deps);
    } catch (err) {
      const msg = (err as Error).message;
      // Multiple "binary not installed" signals across platforms:
      //   - ENOENT: Node spawn (Unix and Windows without shell:true)
      //   - "not found": POSIX shells when shell:true and binary missing
      //   - "is not recognized": cmd.exe's English missing-command message
      //     when knip's PATH fallback runs with shell:true on Windows
      //   - "exited 9009": cmd.exe's exit code for "command not found"
      //     (locale-independent — fires regardless of Windows language)
      //   - "exited 127": POSIX `sh -c` exit code for "command not found"
      //     (fires if shell:true on Unix and binary missing)
      // The 9009/127 codes are the load-bearing signals; the substring
      // matches cover edge cases where Node-wrapping the error obscures
      // the exit code.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
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
      // knip is whole-project; we never passed targetFiles in argv. Report
      // 0 here rather than `targetFiles.length` (which would falsely imply
      // we limited the scan to PR-changed files when knip actually
      // analyzed everything). See the trailing return below for the
      // success path's matching choice.
      return { findings: [], errors, filesExamined: 0 };
    }

    const findings: ScanFinding[] = [];

    // Modern format — `issues[]` array of per-file objects. Each entry has
    // a `file` field plus exports/types/duplicates arrays. If knip emitted
    // any modern-format issues, we trust that as the canonical source and
    // skip the legacy flat-map loops below — pre-fix, knip v5+ that
    // populated BOTH shapes in one blob caused every finding to be
    // emitted twice (same fingerprint, but the per-file cap and comment
    // count doubled).
    //
    // Use `issues !== undefined` (not `issues.length > 0`): a clean knip
    // run emits `{ "issues": [] }` — the key is present but empty. Pre-
    // fix, that evaluated `usedModernFormat = false` and ran the legacy
    // loops anyway, defeating the dedup guard.
    const usedModernFormat = output.issues !== undefined;
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
      // duplicates is nested: each outer element is a group of duplicated
      // symbols, and we flag every member of the group that falls on a
      // PR-added line. JSONReportItem.line is optional in knip's schema
      // (some duplicate categories don't carry a source location), so
      // skip when missing rather than emit a finding pinned to NaN/0.
      for (const duplicateGroup of entry.duplicates ?? []) {
        for (const issue of duplicateGroup) {
          const line = issue.line;
          if (line === undefined) continue;
          if (!changedFile.added_lines.has(line)) continue;
          findings.push(buildDuplicateFinding(changedFile.path, { ...issue, line }));
        }
      }
    }

    // Legacy fallback — older knip versions used flat top-level maps
    // (`exports`/`types`/`duplicates` at the root, keyed by file path).
    // Only run when the modern `issues[]` array was empty/absent;
    // skipping otherwise prevents double-emission on knip v5+ which
    // populates both shapes simultaneously.
    if (!usedModernFormat) {
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
        const line = issue.line;
        if (line === undefined) continue;
        if (!changedFile.added_lines.has(line)) continue;
        findings.push(buildDuplicateFinding(changedFile.path, { ...issue, line }));
      }
    }
    } // end if (!usedModernFormat)

    // knip runs whole-project analysis — no targetFiles in argv. We use
    // `targetFiles` only to filter the OUTPUT to PR-changed lines. So
    // `filesExamined` should reflect the actual scan scope (whole project,
    // unknown count from this vantage point), not the PR-changed subset.
    // Report 0 to avoid misleading operators who read it as "knip only
    // looked at 3 files".
    return { findings, errors, filesExamined: 0 };
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
    // Buffer accumulation — avoids O(n²) string concat on large outputs
    // and UTF-8 corruption across chunk boundaries. knip's whole-project
    // analysis output can be MBs on monorepos.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`knip timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('knip aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`knip killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // Knip exits non-zero when it has findings. 1 = findings, >1 = config/runtime error.
      if (code > 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`knip exited ${code}: ${stderr.trim().slice(0, 500)}`));
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
  // Callers (both modern and legacy paths) MUST have guarded `issue.line`
  // before calling this — knip's schema allows it to be undefined for
  // some duplicate categories, but a finding without a line can't be
  // pinned to a PR-added line. Narrow here to enforce that invariant.
  issue: KnipDuplicateIssue & { line: number },
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
