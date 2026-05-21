/**
 * Concrete `Scanner` for finding hard-coded credentials in changed source.
 *
 * Pipeline per PR:
 *
 *   1. Filter the changed-file set to non-binary, non-generated files. Binary
 *      blobs and generated files (lockfiles, minified JS, snapshots) are noisy
 *      and rarely the source of leaked credentials.
 *   2. Walk each file's `reviewable_lines` ranges. Only lines inside those
 *      ranges are scanned — anything outside is either context the agent
 *      cannot comment on, or pre-existing code we shouldn't flag.
 *   3. For each in-range line, run every effective pattern against
 *      `head_line_text.get(line)`. Patterns carry the `g` flag and may match
 *      multiple times per line; `lastIndex` is reset before each scan so
 *      patterns shared across files don't carry state between iterations.
 *   4. For each match: (a) register the raw value with the redactor so any
 *      subsequent log line that happens to contain it is masked, (b) build a
 *      {@link ScanFinding} whose `evidence.masked_match` is the only place the
 *      string survives, and (c) consult the ignore-list.
 *
 * Pattern set composition:
 *
 *   - `options.patterns`, if supplied, is used verbatim (test hook).
 *   - Otherwise: `DEFAULT_SECRET_PATTERNS` is base. If the caller opts into
 *     generic high-entropy detection via `options.includeGenericEntropy` OR
 *     `config.scanners.secrets.include_generic_entropy`, `GENERIC_ENTROPY_PATTERNS`
 *     is appended. Generic entropy off-by-default because UUIDs, content
 *     hashes, and base64-encoded fixtures cheerfully trip it.
 *
 * Failure contract: this scanner MUST NOT throw. If a single pattern's regex
 * misbehaves (e.g. someone passes a hand-crafted pattern with a bug), the
 * scanner logs a warning, records a non-fatal `ScanError`, and proceeds with
 * the remaining patterns.
 *
 * Critical invariant: the raw match string MUST NEVER appear in `title`,
 * `description`, `suggestion`, or any logger output. Only `evidence.masked_match`
 * (already masked by {@link maskSecret}) is allowed to expose any portion of it.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { registerSecret } from '../util/secrets.js';
import { logger as defaultLogger } from '../util/logger.js';
import type {
  Scanner,
  ScannerDeps,
  ScanResult,
  ScanFinding,
  ScanError,
  ScanEvidence,
  ScannerMetrics,
} from './types.js';
import type { ChangedFile, ScannerId } from '../types.js';
import {
  DEFAULT_SECRET_PATTERNS,
  GENERIC_ENTROPY_PATTERNS,
  type SecretPattern,
} from './secrets-patterns.js';

const SCANNER_ID: ScannerId = 'secrets';

/**
 * Structural type for the logger we accept via DI. Mirrors only the methods
 * this scanner actually calls, so tests can stub without dragging in
 * `@actions/core`.
 */
export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface SecretsScannerOptions {
  /** Override the full pattern list — bypasses both default + generic. */
  patterns?: readonly SecretPattern[];
  /** Opt in to {@link GENERIC_ENTROPY_PATTERNS} when `patterns` is unset. */
  includeGenericEntropy?: boolean;
  /** Override the logger — primarily a DI hook for tests. */
  logger?: Logger;
}

/**
 * Mask a raw secret for safe rendering in `evidence.masked_match`. Strings
 * 8 chars or shorter collapse to `****` (showing any portion would leak the
 * majority of the secret). Longer strings keep the first 4 and last 4 chars
 * around `...` so reviewers can correlate the finding with the leaked value
 * without seeing the full credential.
 */
function maskSecret(match: string): string {
  if (match.length <= 8) return '****';
  return `${match.slice(0, 4)}...${match.slice(-4)}`;
}

/**
 * Deterministic 12-char SHA-1 fingerprint over `${rule_id}:${file_path}:${line}`.
 * Stable across re-runs of the same PR; differs across (rule, file, line)
 * triples so dedup + ignore-list pinning have something concrete to key off.
 *
 * SHA-1 is fine — this is not a security primitive, it's a stable identifier.
 */
function fingerprintOf(rule_id: string, file_path: string, line: number): string {
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${line}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Resolve the effective pattern set for this scan. Order of precedence:
 *
 *   1. Explicit `options.patterns` — used verbatim.
 *   2. `DEFAULT_SECRET_PATTERNS` (always) + `GENERIC_ENTROPY_PATTERNS` iff
 *      generic-entropy is opted in via options or config.
 */
function effectivePatterns(
  options: SecretsScannerOptions,
  deps: ScannerDeps,
): readonly SecretPattern[] {
  if (options.patterns !== undefined) return options.patterns;
  const includeGeneric =
    options.includeGenericEntropy === true ||
    deps.config.scanners?.secrets?.include_generic_entropy === true;
  return includeGeneric
    ? [...DEFAULT_SECRET_PATTERNS, ...GENERIC_ENTROPY_PATTERNS]
    : DEFAULT_SECRET_PATTERNS;
}

/**
 * Build the human-facing `description` for a finding. Intentionally generic —
 * the rendered text never includes the raw match (only the masked form is
 * safe to surface, and even that lives in evidence). The recommendation is
 * always the same: move the value to an env var or secret store.
 */
function buildDescription(pattern: SecretPattern): string {
  return (
    `A string matching the ${pattern.display_name} format was found on this line. ` +
    `If this is a real credential it should be revoked immediately and stored in an environment variable or secrets manager instead of committed source.`
  );
}

export function createSecretsScanner(options: SecretsScannerOptions = {}): Scanner {
  const log = options.logger ?? defaultLogger;

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      for (const f of files) {
        if (!f.is_binary && !f.is_generated) return true;
      }
      return false;
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;

      const patterns = effectivePatterns(options, deps);

      for (const file of deps.changedFiles) {
        if (file.is_binary || file.is_generated) continue;
        files_examined += 1;

        for (const [rangeStart, rangeEnd] of file.reviewable_lines) {
          for (let lineNo = rangeStart; lineNo <= rangeEnd; lineNo += 1) {
            const text = file.head_line_text.get(lineNo);
            if (text === undefined) continue;

            for (const pattern of patterns) {
              try {
                // Reset shared regex state. Patterns carry the `g` flag and
                // are shared across calls — without resetting, the next exec()
                // would start from wherever the previous file left off.
                pattern.pattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = pattern.pattern.exec(text)) !== null) {
                  const raw = m[0];

                  // Apply postCheck (entropy gate, etc.) before doing anything
                  // that could surface the value.
                  if (pattern.postCheck && !pattern.postCheck(raw)) {
                    if (m.index === pattern.pattern.lastIndex) {
                      pattern.pattern.lastIndex += 1; // safety vs. zero-width
                    }
                    continue;
                  }

                  // Critical ordering: register BEFORE building any object
                  // that we might inadvertently log later.
                  registerSecret(raw);

                  const rule_id = `secret:${pattern.id}`;
                  const evidence: ScanEvidence = {
                    kind: 'secret',
                    masked_match: maskSecret(raw),
                    pattern_id: pattern.id,
                  };
                  const finding: ScanFinding = {
                    scanner: SCANNER_ID,
                    rule_id,
                    file_path: file.path,
                    line: lineNo,
                    severity: pattern.severity,
                    category: 'vulnerability',
                    confidence: pattern.confidence,
                    title: `Possible ${pattern.display_name} in ${path.basename(file.path)}`,
                    description: buildDescription(pattern),
                    evidence,
                    fingerprint: fingerprintOf(rule_id, file.path, lineNo),
                  };

                  const match = deps.ignoreList.matches(finding);
                  if (match.ignored) {
                    if (match.expired) {
                      void log.notice(
                        `secrets: ignore entry for ${finding.rule_id} (${finding.file_path}:${finding.line}) is expired; finding still suppressed but will need refresh. Reason: ${match.reason ?? '(no reason)'}`,
                      );
                    }
                    // Advance past zero-width matches before the next iteration.
                    if (m.index === pattern.pattern.lastIndex) {
                      pattern.pattern.lastIndex += 1;
                    }
                    continue;
                  }
                  findings.push(finding);

                  // Safety: if a pattern matched at lastIndex === m.index (zero
                  // width), bump to avoid an infinite loop.
                  if (m.index === pattern.pattern.lastIndex) {
                    pattern.pattern.lastIndex += 1;
                  }
                }
              } catch (err) {
                void log.warn(
                  `secrets: pattern ${pattern.id} threw on ${file.path}:${lineNo}: ${(err as Error).message}`,
                );
                errors.push({
                  message: `Pattern ${pattern.id} threw while scanning ${file.path}`,
                  cause: (err as Error).message,
                  fatal: false,
                });
                // Avoid leaking failed-pattern state into the next iteration.
                pattern.pattern.lastIndex = 0;
              }
            }
          }
        }
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: buildMetrics(started, files_examined, deps.cache.hit_count),
      };
    },
  };
}

function buildMetrics(
  started: number,
  files_examined: number,
  cache_hits: number,
): ScannerMetrics {
  return {
    duration_ms: Date.now() - started,
    files_examined,
    network_calls: 0,
    cache_hits,
  };
}
