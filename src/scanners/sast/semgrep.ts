/**
 * Semgrep linter module — runs the target repo's semgrep against changed
 * files, with the auto-detected ruleset.
 *
 * Why this exists: pattern-recognition (security anti-patterns, N+1 in
 * loops, dangerous string concatenation, etc.) was identified as ~15% of
 * Sonnet's tool-loop overhead. Semgrep was specifically called out as the
 * deterministic tool for these checks. Each semgrep finding the agent
 * would have spent multiple turns finding (grep for the pattern, read
 * surrounding code, decide if it's the anti-pattern) is now produced in
 * one CLI invocation at zero token cost.
 *
 * Cross-language by design — semgrep ships with rule packs for TS/JS,
 * Python, Go, Ruby, Java, Rust, C/C++, and more. The `--config=auto`
 * flag picks rules based on the languages it detects in the workspace.
 *
 * Activation: requires `semgrep` on PATH (single-binary install via
 * `pip install semgrep` or `brew install semgrep`). Returns empty
 * quietly when missing.
 *
 * Output format: `semgrep scan --json` emits:
 *   { results: [{ check_id, path, start: { line, col }, extra: { message, severity, lines } }, ...], errors: [...] }
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

const ID = 'semgrep';
const TIMEOUT_MS = 180_000;
// Semgrep handles many languages; we let semgrep's auto-config decide
// which rules apply. We only filter the input set to non-binary,
// non-generated source files to avoid wasting semgrep cycles on lockfiles.
const PROBABLY_SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|rb|java|kt|c|cc|cpp|h|hpp|cs|php|swift|m|mm|scala|clj|ex|exs|sh|bash|yaml|yml|tf|hcl)$/;

interface SemgrepOutput {
  results: SemgrepResult[];
  errors?: SemgrepError[];
}

/**
 * Subset of semgrep's per-error JSON shape. semgrep emits these in
 * `output.errors` when individual files fail to parse, rules fail to
 * download, etc. — the run can still produce findings on the files that
 * succeeded, but operators should see the partial-failure signal.
 */
interface SemgrepError {
  message?: string;
  type?: string;
  level?: string;
  path?: string;
  short_msg?: string;
}

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col?: number };
  end?: { line: number; col?: number };
  extra: {
    message: string;
    severity: 'INFO' | 'WARNING' | 'ERROR';
    /** The matched lines, joined. We include in the description. */
    lines?: string;
    /** Optional rule metadata — category, CWE, OWASP. */
    metadata?: {
      category?: string;
      cwe?: string | string[];
      owasp?: string | string[];
    };
  };
}

export const semgrepLinter: LinterModule = {
  id: ID,
  applies(files: readonly ChangedFile[]): boolean {
    return files.some(
      (f) => PROBABLY_SOURCE.test(f.path) && !f.is_binary && !f.is_generated,
    );
  },
  async run(deps: ScannerDeps, targetFiles: readonly ChangedFile[]): Promise<LinterRun> {
    const errors: ScanError[] = [];

    // Option-confusion guard: a PR file named `--config=evil.yaml` or
    // `--output=/tmp/exfil` would be parsed as a semgrep flag, not a
    // target. shell:false here so we only need the leading-dash filter,
    // not the metachar/quoting branch.
    const { safe, dropped } = filterShellSafePaths(
      targetFiles.map((f) => f.path),
      false,
    );
    if (dropped.length > 0) {
      await logger.warn(
        `semgrep: skipped ${dropped.length} file(s) with leading-dash names: ${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '...' : ''}`,
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
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        return { findings: [], errors: [], filesExamined: 0 };
      }
      errors.push({ message: `semgrep failed: ${msg}`, fatal: false });
      return { findings: [], errors, filesExamined: 0 };
    }

    let output: SemgrepOutput;
    try {
      output = JSON.parse(rawOutput) as SemgrepOutput;
    } catch (err) {
      errors.push({
        message: `semgrep output parse failed: ${(err as Error).message}`,
        fatal: false,
      });
      // Even on parse failure semgrep was invoked and made the
      // --config=auto network call, so count the egress.
      return { findings: [], errors, filesExamined: targetFiles.length, networkCalls: 1 };
    }

    // Surface semgrep's own errors[] — partial-scan failures (a file
    // fails to parse, a rule fails to download) leave `results` healthy
    // but reduce coverage. Pre-fix, operators saw a "successful" run
    // with no signal that some files were skipped. Emit each as a
    // non-fatal ScanError so they show up in the run summary.
    for (const semgrepErr of output.errors ?? []) {
      const message = semgrepErr.message ?? semgrepErr.short_msg ?? semgrepErr.type ?? 'unknown error';
      const pathSuffix = semgrepErr.path !== undefined ? ` (${semgrepErr.path})` : '';
      errors.push({
        message: `semgrep partial: ${message}${pathSuffix}`,
        fatal: false,
      });
    }

    const findings: ScanFinding[] = [];
    for (const result of output.results ?? []) {
      const relPath = normalizeToolPath(deps.workspaceDir, result.path);
      const changedFile = deps.changedFiles.find((f) => f.path === relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(result.start.line)) continue;
      findings.push(buildFinding(changedFile.path, result, changedFile));
    }

    // Successful invocation — conservatively count 1 network call. The
    // `--config=auto` resolver MAY contact semgrep.dev to fetch rules,
    // but warm runners hit the on-disk cache and never egress. We can't
    // tell from the exit code which happened, so we count 1 to avoid
    // undercounting on cold runners. Operators needing exact egress
    // accounting should switch to `--config=<local-path>` and patch
    // this metric to 0.
    return {
      findings,
      errors,
      filesExamined: targetFiles.length,
      networkCalls: 1,
    };
  },
};

function runCli(files: string[], deps: ScannerDeps): Promise<string> {
  return new Promise((resolve, reject) => {
    // --config=auto pulls the appropriate ruleset for detected languages.
    // --quiet suppresses the human-readable summary that would corrupt the
    // JSON output. --no-rewrite-rule-ids keeps check_ids stable across
    // runs for fingerprinting. --metrics=off suppresses semgrep's default
    // telemetry beacon to semgrep.dev (separate from --disable-version-check,
    // which only stops the version ping). Operators with strict egress
    // controls or data-residency requirements need this off; the
    // --config=auto rule fetch is already documented and accounted for in
    // networkCalls, the metrics beacon was an undocumented additional call.
    const child = spawn(
      'semgrep',
      [
        'scan',
        '--json',
        '--quiet',
        '--config=auto',
        '--no-rewrite-rule-ids',
        '--disable-version-check',
        '--metrics=off',
        // End-of-options separator — defense in depth alongside the
        // leading-dash filter above. If anything slips through (e.g. a
        // future caller forgets to filter), `--` guarantees semgrep
        // treats every following token as a target, not an option.
        '--',
        ...files,
      ],
      {
        cwd: deps.workspaceDir,
        env: buildLinterEnv(),
      },
    );
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`semgrep timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('semgrep aborted'));
      },
      { once: true },
    );
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Semgrep exit codes: 0 = clean, 1 = findings, 2 = errors but partial
      // results, >2 = fatal. 0/1/2 produce parseable JSON.
      if (code !== null && code > 2) {
        reject(new Error(`semgrep exited ${code}: ${stderr.trim().slice(0, 500)}`));
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

function buildFinding(
  filePath: string,
  result: SemgrepResult,
  changedFile: { added_lines: ReadonlySet<number> },
): ScanFinding {
  const severity: Severity = severityFromSemgrep(result.extra.severity);
  const category: Category = categorize(result);
  const confidence: Confidence = 'high';
  const fingerprint = `${ID}:${result.check_id}:${filePath}:${result.start.line}`;
  const startLine = result.start.line;
  const endLine = result.end?.line;
  // Anchor on the START line. Only attach a multi-line range when BOTH
  // endpoints are reviewable; otherwise the validator would drop the
  // finding for a violation that starts on an added line but extends
  // into context lines.
  const useRange =
    endLine !== undefined &&
    endLine > startLine &&
    changedFile.added_lines.has(endLine);
  const cweRaw = result.extra.metadata?.cwe;
  const cwe = Array.isArray(cweRaw) ? cweRaw : cweRaw !== undefined ? [cweRaw] : [];
  return {
    scanner: 'sast',
    rule_id: `${ID}/${result.check_id}`,
    file_path: filePath,
    line: useRange ? endLine : startLine,
    ...(useRange ? { start_line: startLine } : {}),
    severity,
    category,
    title: renderTitle(result),
    description: renderDescription(result),
    confidence,
    evidence: { kind: 'sast', cwe },
    fingerprint,
  };
}

function severityFromSemgrep(s: SemgrepResult['extra']['severity']): Severity {
  if (s === 'ERROR') return 'important';
  if (s === 'WARNING') return 'minor';
  return 'nit';
}

function categorize(result: SemgrepResult): Category {
  const ruleCategory = result.extra.metadata?.category;
  // Common semgrep rule categories: security, correctness, performance,
  // best-practice, maintainability.
  if (ruleCategory === 'security') return 'vulnerability';
  if (ruleCategory === 'correctness') return 'bug';
  if (ruleCategory === 'performance') return 'performance';
  // Fall back to check_id heuristics — semgrep packs often use prefixes
  // like `python.lang.security.foo` that hint at the category.
  if (result.check_id.includes('security')) return 'vulnerability';
  if (result.check_id.includes('correctness') || result.check_id.includes('bug')) {
    return 'bug';
  }
  if (result.check_id.includes('performance') || result.check_id.includes('perf')) {
    return 'performance';
  }
  return 'readability';
}

function renderTitle(result: SemgrepResult): string {
  // Take the first line of semgrep's message — semgrep messages are often
  // multi-paragraph with mitigation guidance.
  const firstLine = result.extra.message.split('\n')[0]!.trim();
  const ruleStr = `[${ID}/${result.check_id}] `;
  const candidate = `${ruleStr}${firstLine}`;
  return candidate.length > 120 ? candidate.slice(0, 117) + '...' : candidate;
}

function renderDescription(result: SemgrepResult): string {
  const cweRaw = result.extra.metadata?.cwe;
  const cwes = Array.isArray(cweRaw) ? cweRaw.join(', ') : cweRaw;
  const meta: string[] = [];
  if (cwes !== undefined && cwes.length > 0) meta.push(`CWE: ${cwes}`);
  if (result.extra.metadata?.owasp !== undefined) {
    const owasp = Array.isArray(result.extra.metadata.owasp)
      ? result.extra.metadata.owasp.join(', ')
      : result.extra.metadata.owasp;
    meta.push(`OWASP: ${owasp}`);
  }
  const metaStr = meta.length > 0 ? `\n\n_${meta.join(' · ')}_` : '';
  return `Semgrep rule: \`${result.check_id}\`.\n\n${result.extra.message.trim()}${metaStr}`;
}
