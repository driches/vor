/**
 * Concrete `Scanner` for left-behind development artifacts ("debris") in
 * changed source: merge-conflict markers, `debugger`/`breakpoint()`
 * statements, focused tests (`.only`/`fdescribe`/`fit`), and stray
 * console/debug logging.
 *
 * Why this exists: these are deterministic, high-signal mistakes that should
 * never reach a reviewer's attention budget — a committed `<<<<<<<` breaks the
 * build, a stray `describe.only` silently disables the rest of the suite in
 * CI, a leftover `debugger` halts execution under devtools. A regex catches
 * them in milliseconds at zero token cost.
 *
 * Pipeline mirrors the secrets scanner exactly (see `secrets.ts`):
 *   1. Skip binary/generated files.
 *   2. Walk each file's `added_lines` (the strict `+` lines) — NEVER context
 *      lines, so we only flag debris this PR actually introduced.
 *   3. Run every rule whose `appliesTo(file)` predicate accepts the file
 *      against `head_line_text.get(line)`.
 *   4. Build a {@link ScanFinding} per match and consult the ignore-list.
 *
 * Failure contract: MUST NOT throw. A rule whose regex misbehaves logs a
 * warning, records a non-fatal `ScanError`, and the scan proceeds with the
 * remaining rules.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger as defaultLogger } from '../util/logger.js';
import type {
  Scanner,
  ScannerDeps,
  ScanResult,
  ScanFinding,
  ScanError,
  ScannerMetrics,
} from './types.js';
import { expiredIgnoreNotice } from './ignore-list.js';
import type { Category, ChangedFile, Confidence, ScannerId, Severity } from '../types.js';

const SCANNER_ID: ScannerId = 'debris';

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface DebrisScannerOptions {
  /** Override the rule list — primarily a DI hook for tests. */
  rules?: readonly DebrisRule[];
  /** Override the logger — primarily a DI hook for tests. */
  logger?: Logger;
}

interface DebrisRule {
  /** Stable id; becomes `debris:<id>` as the finding's rule_id. */
  id: string;
  /** Global regex evaluated against each added line's text. */
  pattern: RegExp;
  severity: Severity;
  category: Category;
  confidence: Confidence;
  /** Short human title (file basename is appended at finding-build time). */
  title: string;
  description: string;
  /** Cheap per-file gate so JS-only rules don't run on `.py`, etc. */
  appliesTo: (file: ChangedFile) => boolean;
}

const JS_TS_EXT = /\.(?:m|c)?[jt]sx?$/i;
const PY_EXT = /\.py$/i;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/i;

function isJsTs(file: ChangedFile): boolean {
  return JS_TS_EXT.test(file.path);
}
function isPython(file: ChangedFile): boolean {
  return PY_EXT.test(file.path);
}
function isTest(file: ChangedFile): boolean {
  return TEST_PATH.test(file.path);
}

/**
 * Default rule set. Tuned for high signal / low noise: every rule here is a
 * mistake in essentially all repositories. Noisier heuristics (TODO/FIXME,
 * commented-out code) are deliberately omitted.
 */
export const DEFAULT_DEBRIS_RULES: readonly DebrisRule[] = [
  {
    // Anchored at line start so it can't match `=======` inside an
    // underlined Markdown heading body or a comment banner. `<<<<<<<` /
    // `>>>>>>>` / `|||||||` followed by a space-or-EOL is unambiguous: Git
    // conflict markers are exactly seven of the character then a space (and
    // a ref) or nothing. Language-agnostic — applies to every text file.
    id: 'merge-conflict',
    pattern: /^(?:<{7}|>{7}|\|{7})(?:\s|$)/g,
    severity: 'critical',
    category: 'bug',
    confidence: 'high',
    title: 'Unresolved merge-conflict marker',
    description:
      'A line begins with a Git merge-conflict marker (`<<<<<<<`, `|||||||`, or `>>>>>>>`). ' +
      'This is almost certainly an unresolved conflict committed by accident — it will fail to ' +
      'parse/compile. Resolve the conflict and remove the markers.',
    appliesTo: (f) => !f.is_binary && !f.is_generated,
  },
  {
    // `describe.only` / `it.only` / `test.only` / `context.only`, plus the
    // Jasmine/Jest globals `fdescribe` / `fit`. These silently skip every
    // OTHER test in the file, so CI goes green while coverage quietly drops.
    //
    // Gated to test files: focused tests only matter to a test runner (which
    // loads test files), and the bare `fit(` / `fdescribe(` alternatives are
    // ordinary identifiers in production code — e.g. a `fit(model, data)`
    // call in `src/geometry.ts` must NOT be flagged.
    id: 'focused-test',
    pattern: /\b(?:describe|context|it|test)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/g,
    severity: 'important',
    category: 'test-gap',
    confidence: 'high',
    title: 'Focused test will skip the rest of the suite',
    description:
      'A focused test (`.only`, `fdescribe`, or `fit`) was added. Test runners execute ONLY ' +
      'focused tests and silently skip every other test in the file, so CI can pass while most ' +
      'of the suite never runs. Remove the focus before merging.',
    appliesTo: (f) => isJsTs(f) && isTest(f),
  },
  {
    // Require the trailing `;` to avoid matching the word "debugger" in prose
    // or identifiers like `debuggerEnabled`.
    id: 'debugger',
    pattern: /\bdebugger\s*;/g,
    severity: 'minor',
    category: 'bug',
    confidence: 'high',
    title: 'Leftover `debugger` statement',
    description:
      'A `debugger;` statement was added. It halts execution whenever devtools are open and ' +
      'should not ship to production. Remove it.',
    appliesTo: isJsTs,
  },
  {
    // Python debugger entrypoints: the `breakpoint()` builtin and the classic
    // `pdb.set_trace()` / `ipdb.set_trace()`.
    id: 'python-debugger',
    pattern: /\bbreakpoint\s*\(\s*\)|\b(?:i?pdb)\.set_trace\s*\(/g,
    severity: 'minor',
    category: 'bug',
    confidence: 'high',
    title: 'Leftover Python debugger call',
    description:
      'A debugger entrypoint (`breakpoint()` or `pdb.set_trace()`) was added. It will block ' +
      'execution waiting for an interactive prompt if it reaches production. Remove it.',
    appliesTo: isPython,
  },
  {
    // Stray console logging in NON-test JS/TS. Low severity by design: many
    // codebases log intentionally, so this is a nudge, not a blocker, and is
    // suppressed in test files where console output is routine.
    id: 'console-log',
    pattern: /\bconsole\.(?:log|debug|info)\s*\(/g,
    severity: 'nit',
    category: 'readability',
    confidence: 'medium',
    title: 'Stray console logging',
    description:
      'A `console.log`/`debug`/`info` call was added in non-test source. If this is leftover ' +
      'debugging output, remove it or switch to the project logger.',
    appliesTo: (f) => isJsTs(f) && !isTest(f),
  },
];

/** Deterministic 12-char fingerprint, mirroring the secrets scanner. */
function fingerprintOf(
  rule_id: string,
  file_path: string,
  line: number,
  matchIndex: number,
): string {
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${line}:${matchIndex}`)
    .digest('hex')
    .slice(0, 12);
}

/** Truncate a line excerpt so a very long minified line can't bloat evidence. */
function snippetOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}

export function createDebrisScanner(options: DebrisScannerOptions = {}): Scanner {
  const log = options.logger ?? defaultLogger;
  const rules = options.rules ?? DEFAULT_DEBRIS_RULES;

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      for (const f of files) {
        if (f.is_binary || f.is_generated) continue;
        if (rules.some((r) => r.appliesTo(f))) return true;
      }
      return false;
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;

      for (const file of deps.changedFiles) {
        if (file.is_binary || file.is_generated) continue;
        const applicable = rules.filter((r) => r.appliesTo(file));
        if (applicable.length === 0) continue;
        files_examined += 1;

        for (const lineNo of file.added_lines) {
          const text = file.head_line_text.get(lineNo);
          if (text === undefined) continue;

          for (const rule of applicable) {
            let matchIndex = 0;
            try {
              rule.pattern.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = rule.pattern.exec(text)) !== null) {
                const rule_id = `debris:${rule.id}`;
                const finding: ScanFinding = {
                  scanner: SCANNER_ID,
                  rule_id,
                  file_path: file.path,
                  line: lineNo,
                  severity: rule.severity,
                  category: rule.category,
                  confidence: rule.confidence,
                  title: `${rule.title} in ${path.basename(file.path)}`,
                  description: rule.description,
                  evidence: { kind: 'debris', rule: rule.id, snippet: snippetOf(text) },
                  fingerprint: fingerprintOf(rule_id, file.path, lineNo, matchIndex++),
                };

                const match = deps.ignoreList.matches(finding);
                if (!match.ignored) {
                  findings.push(finding);
                } else if (match.expired) {
                  void log.notice(expiredIgnoreNotice('debris', finding, match));
                }

                // Guard against zero-width matches (none of the default rules
                // are zero-width, but a custom rule could be).
                if (m.index === rule.pattern.lastIndex) {
                  rule.pattern.lastIndex += 1;
                }
              }
            } catch (err) {
              void log.warn(
                `debris: rule ${rule.id} threw on ${file.path}:${lineNo}: ${(err as Error).message}`,
              );
              errors.push({
                message: `Rule ${rule.id} threw while scanning ${file.path}`,
                cause: (err as Error).message,
                fatal: false,
              });
              rule.pattern.lastIndex = 0;
            }
          }
        }
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: buildMetrics(started, files_examined),
      };
    },
  };
}

function buildMetrics(started: number, files_examined: number): ScannerMetrics {
  return {
    duration_ms: Date.now() - started,
    files_examined,
    network_calls: 0,
    cache_hits: 0,
  };
}
