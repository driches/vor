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
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Category, ChangedFile, Confidence, Severity } from '../../types.js';
import type { ScannerDeps, ScanError, ScanFinding } from '../types.js';
import {
  buildLinterEnv,
  filterShellSafePaths,
  normalizeToolPath,
  SEMGREP_EXTRA_ENV_KEYS,
  type LinterModule,
  type LinterRun,
} from './linter.js';
import { logger } from '../../util/logger.js';

const ID = 'semgrep';
const TIMEOUT_MS = 180_000;
// Semgrep handles many languages; we let semgrep's auto-config decide
// which rules apply. We only filter the input set to non-binary,
// non-generated source files to avoid wasting semgrep cycles on lockfiles.
const PROBABLY_SOURCE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|rb|java|kt|c|cc|cpp|h|hpp|cs|php|swift|m|mm|scala|clj|ex|exs|sh|bash|yaml|yml|tf|hcl)$/;

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
    return files.some((f) => PROBABLY_SOURCE.test(f.path) && !f.is_binary && !f.is_generated);
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

    // Resolve the optional custom-rules directory. The config layer
    // defaults this to '.vor/semgrep-rules'; we only forward it to
    // semgrep when something actually exists at the resolved path so that
    // unset-or-absent stays a true no-op (no extra `--config` flag, no
    // semgrep error). Existence is checked, not readability — if the path
    // exists but is unreadable, semgrep itself will surface the error.
    const customRulesPath = await resolveCustomRulesPath(deps);

    let rawOutput: string;
    try {
      rawOutput = await runCli(safe, deps, customRulesPath);
    } catch (err) {
      const msg = (err as Error).message;
      // Match knip/ruff: `command not found` (the POSIX shell prefix)
      // is the specific signal — bare `not found` would also match real
      // semgrep runtime errors like "Rule not found", "Config file not
      // found", "Path not found", silently swallowing them. Exit codes
      // (9009/127) remain the load-bearing locale-independent signals.
      const isMissingBinary =
        msg.includes('ENOENT') ||
        msg.includes('command not found') ||
        msg.includes('is not recognized') ||
        msg.includes('exited 9009') ||
        msg.includes('exited 127');
      if (isMissingBinary) {
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
      // Don't count a network call on parse failure: a non-JSON output
      // could just as easily mean the binary errored before reaching the
      // network (version-mismatch banner, missing-config message, etc.).
      // For air-gapped operators auditing egress with this metric,
      // undercounting an uncertain case is safer than overcounting.
      return { findings: [], errors, filesExamined: targetFiles.length };
    }

    // Surface semgrep's own errors[] — partial-scan failures (a file
    // fails to parse, a rule fails to download) leave `results` healthy
    // but reduce coverage. Pre-fix, operators saw a "successful" run
    // with no signal that some files were skipped. Emit each as a
    // non-fatal ScanError so they show up in the run summary.
    for (const semgrepErr of output.errors ?? []) {
      const message =
        semgrepErr.message ?? semgrepErr.short_msg ?? semgrepErr.type ?? 'unknown error';
      const pathSuffix = semgrepErr.path !== undefined ? ` (${semgrepErr.path})` : '';
      errors.push({
        message: `semgrep partial: ${message}${pathSuffix}`,
        fatal: false,
      });
    }

    const filesByPath = new Map(targetFiles.map((f) => [f.path, f]));
    const findings: ScanFinding[] = [];
    for (const result of output.results ?? []) {
      const relPath = normalizeToolPath(deps.workspaceDir, result.path);
      const changedFile = filesByPath.get(relPath);
      if (changedFile === undefined) continue;
      if (!changedFile.added_lines.has(result.start.line)) continue;
      findings.push(buildFinding(changedFile.path, result, changedFile));
    }

    // Count 2 network calls for any run that reached the JSON-parse stage:
    //   1. `--config=auto` rule fetch from the semgrep registry
    //   2. semgrep's default metrics POST (sent on any registry-pulling run)
    //
    // Both happen on every successful semgrep invocation. Warm runners hit
    // the on-disk rule cache for (1) and skip actual egress, but we can't
    // tell from the exit code which path the binary took, so we count the
    // attempt. The metrics call was previously suppressed via `--metrics=off`
    // — that flag was removed because semgrep 1.150+ rejects it alongside
    // `--config=auto` (PR #33). Exit 2 specifically means "errors but
    // partial results" — still counts because rules were fetched before
    // scanning began. Operators needing exact egress accounting should
    // switch to `--config=<local-path>` (see TODO in runCli below).
    return {
      findings,
      errors,
      filesExamined: targetFiles.length,
      networkCalls: 2,
    };
  },
};

/**
 * Resolve `security.scanners.sast.semgrep.custom_rules_path` against the
 * workspace, returning the absolute path when the directory actually
 * exists and `null` otherwise. The "exists but missing on disk" case is
 * common (e.g. a consumer hasn't shipped their own pack yet, or only the
 * default scaffolding is present) and must NOT fail the run — we log at
 * debug and forward only `--config=auto`.
 *
 * Exported for tests; the only caller in product code is `run()`.
 */
export async function resolveCustomRulesPath(deps: ScannerDeps): Promise<string | null> {
  const customRulesPath = deps.config?.scanners?.sast?.semgrep?.custom_rules_path;
  if (customRulesPath === undefined || customRulesPath.length === 0) {
    return null;
  }
  const absPath = path.isAbsolute(customRulesPath)
    ? customRulesPath
    : path.resolve(deps.workspaceDir, customRulesPath);
  if (!existsSync(absPath)) {
    await logger.debug(
      `semgrep: custom_rules_path ${customRulesPath} not found at ${absPath}, skipping`,
    );
    return null;
  }
  // Allow either a directory of rule YAMLs (the common case — multiple
  // rules grouped by topic) OR a single rule file (an operator who wants
  // just one pattern). Both are valid `--config` arguments to semgrep.
  try {
    statSync(absPath);
  } catch (err) {
    await logger.debug(
      `semgrep: custom_rules_path ${absPath} stat failed (${(err as Error).message}), skipping`,
    );
    return null;
  }
  return absPath;
}

function runCli(
  files: string[],
  deps: ScannerDeps,
  customRulesPath: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // --config=auto pulls the appropriate ruleset for detected languages.
    // --quiet suppresses semgrep's progress output on stderr, reducing CI
    // log noise. The JSON results go to stdout regardless; --quiet does
    // not affect the JSON stream (those are separate file descriptors).
    // --no-rewrite-rule-ids keeps check_ids stable across runs for
    // fingerprinting.
    //
    // Note on metrics: we used to pass `--metrics=off` to suppress
    // semgrep's default telemetry beacon. Semgrep 1.150+ rejects that
    // flag alongside `--config=auto` ("Cannot create auto config when
    // metrics are off"), so the whole linter would silently fail on
    // every PR (see PR #33). Each successful run now does TWO network
    // calls (registry rule fetch + metrics POST) — both are accounted
    // for in the `networkCalls: 2` field below. Operators with strict
    // data-residency requirements should disable semgrep entirely via
    // `security.scanners.sast.enabled: false`.
    //
    // Custom rules: semgrep accepts MULTIPLE `--config` flags and merges
    // them into a single rule set. When `custom_rules_path` is set AND
    // the path exists on disk (checked in run() above), we append a
    // second `--config <abs_path>` so the bundled rule pack (N+1, sync-
    // in-async, raw SQL, missing auth) layers on top of the auto-detected
    // packs. Order is auto first, custom second — both contribute, no
    // override semantics.
    //
    // TODO(v0.4.2): still needed for strict-egress operators:
    //   1. `security.scanners.sast.linters.semgrep.enabled: false` — a
    //      per-linter escape hatch so an operator can disable JUST semgrep
    //      without losing the other five linters (eslint/ruff/dart/
    //      actionlint/knip), none of which make network calls.
    const args = [
      'scan',
      '--json',
      '--quiet',
      '--config=auto',
      ...(customRulesPath !== null ? ['--config', customRulesPath] : []),
      '--no-rewrite-rule-ids',
      '--disable-version-check',
      // Note: cannot pass `--metrics=off` here. Semgrep 1.150+ rejects
      // `--config=auto` + `--metrics=off` as incompatible at startup
      // (`Cannot create auto config when metrics are off`) and exits
      // with no JSON output. The orchestrator then sees empty stdout
      // → JSON.parse throws → the WHOLE semgrep linter fails for
      // every PR. Operators with strict egress requirements should
      // disable semgrep via `security.scanners.sast.enabled: false`
      // or (future v0.5) `linters.semgrep.enabled: false` rather than
      // trying to combine these flags.
      // End-of-options separator — defense in depth alongside the
      // leading-dash filter above. If anything slips through (e.g. a
      // future caller forgets to filter), `--` guarantees semgrep
      // treats every following token as a target, not an option.
      '--',
      ...files,
    ];
    const child = spawn('semgrep', args, {
      cwd: deps.workspaceDir,
      // SEMGREP_EXTRA_ENV_KEYS is per-linter scoped (not in the shared
      // allowlist) so SEMGREP_APP_TOKEN only reaches semgrep — a
      // malicious workspace-resolved eslint/ruff/knip binary cannot
      // read this credential.
      env: buildLinterEnv(SEMGREP_EXTRA_ENV_KEYS),
    });
    // Buffer accumulation — semgrep JSON on a large monorepo with
    // --config=auto can be tens of MB. The pre-fix `stdout += chunk`
    // pattern was O(n²) AND risked UTF-8 corruption on chunk boundaries.
    // Per-linter TIMEOUT_MS (180s) provides runaway protection. A prior
    // attempt at a hard byte cap correlated with a CI hang that ran out
    // the GH Actions 45-min budget; reverted while investigating.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`semgrep timed out after ${TIMEOUT_MS}ms`));
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
        reject(new Error('semgrep aborted'));
      },
      { once: true },
    );
    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === null) {
        // OS killed the process — partial output, reject clearly.
        reject(new Error(`semgrep killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      // Semgrep exit codes: 0 = clean, 1 = findings, 2 = errors but partial
      // results, >2 = fatal. 0/1/2 produce parseable JSON.
      if (code > 2) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`semgrep exited ${code}: ${stderr.trim().slice(0, 500)}`));
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
  result: SemgrepResult,
  changedFile: { added_lines: ReadonlySet<number> },
): ScanFinding {
  const severity: Severity = severityFromSemgrep(result.extra.severity);
  const category: Category = categorize(result);
  const confidence: Confidence = 'high';
  const startLine = result.start.line;
  const endLine = result.end?.line;
  // Anchor on the START line. Only attach a multi-line range when BOTH
  // endpoints are reviewable; otherwise the validator would drop the
  // finding for a violation that starts on an added line but extends
  // into context lines.
  const useRange =
    endLine !== undefined && endLine > startLine && changedFile.added_lines.has(endLine);
  // Fingerprint anchors at the line we actually post the comment at —
  // see eslint.ts for the full rationale. Pre-fix this used startLine
  // unconditionally, so useRange findings dedup'd against a different
  // key than the one their comment lives at, breaking re-run dedup.
  const fingerprint = `${ID}:${result.check_id}:${filePath}:${useRange ? endLine : startLine}`;
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
