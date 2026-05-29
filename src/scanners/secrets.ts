/**
 * Concrete `Scanner` for finding hard-coded credentials in changed source.
 *
 * Pipeline per PR:
 *
 *   1. Filter the changed-file set to non-binary, non-generated files. Binary
 *      blobs and generated files (lockfiles, minified JS, snapshots) are noisy
 *      and rarely the source of leaked credentials.
 *   2. Walk each file's `added_lines` set — ONLY lines this PR actually added
 *      with a leading `+` in the diff. We deliberately ignore context lines
 *      (in `reviewable_lines` but not `added_lines`) because a secret on a
 *      context line pre-dates this PR and flagging it here would be noise.
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
import { expiredIgnoreNotice } from './ignore-list.js';
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
 * Deterministic 12-char SHA-1 fingerprint over
 * `${rule_id}:${file_path}:${line}:${matchIndex}`.
 *
 * `matchIndex` disambiguates multiple matches of the same pattern on the
 * same line — without it, two AWS keys on one line would produce identical
 * fingerprints and pass-1 dedup would silently collapse them to one
 * finding (so the second credential never gets flagged). Stable across
 * re-runs because pattern iteration + match ordering are both deterministic.
 *
 * SHA-1 is fine — this is not a security primitive, it's a stable identifier.
 */
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

        // Iterate `added_lines` (the strict `+` lines of the PR), not
        // `reviewable_lines` (which also includes ` ` context lines). A secret
        // on a context line was already there before this PR — out of scope.
        for (const lineNo of file.added_lines) {
          const text = file.head_line_text.get(lineNo);
          if (text === undefined) continue;

          for (const pattern of patterns) {
            // Per-(line, pattern) match index. Reset on every iteration so
            // the fingerprint depends ONLY on (rule, file, line, ordinal-
            // within-this-line). Stable across reruns — e.g. adding a new
            // match in an earlier file no longer shifts subsequent
            // fingerprints, which would otherwise break ignore-list pinning.
            let lineMatchIndex = 0;
            try {
              // Reset shared regex state. Patterns carry the `g` flag and
              // are shared across calls — without resetting, the next exec()
              // would start from wherever the previous file left off.
              pattern.pattern.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = pattern.pattern.exec(text)) !== null) {
                // Pull the credential out of the capture group rather than
                // the full match. Today they're identical because every
                // pattern uses zero-width lookarounds, but a future pattern
                // with non-zero-width outer chars (e.g. `"([^"]+)"`) would
                // pass surrounding delimiters into `registerSecret` and
                // `maskSecret` — wrong masking, wrong redaction.
                const raw = m[1] ?? m[0];

                // Apply postCheck (entropy gate, etc.) before doing anything
                // that could surface the value.
                if (pattern.postCheck && !pattern.postCheck(raw)) {
                  if (m.index === pattern.pattern.lastIndex) {
                    pattern.pattern.lastIndex += 1; // safety vs. zero-width
                  }
                  continue;
                }

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
                  // Per-line ordinal of this match within (file, line,
                  // pattern). Stable across reruns regardless of what other
                  // files/patterns produced. Post-increment so the next
                  // match on the same line gets index+1; ignored matches
                  // still advance the counter so subsequent ordinals don't
                  // shift when an ignore-list entry is added or removed.
                  fingerprint: fingerprintOf(rule_id, file.path, lineNo, lineMatchIndex++),
                };

                const match = deps.ignoreList.matches(finding);
                if (match.ignored) {
                  if (match.expired) {
                    void log.notice(expiredIgnoreNotice('secrets', finding, match));
                  }
                  // Advance past zero-width matches before the next iteration.
                  if (m.index === pattern.pattern.lastIndex) {
                    pattern.pattern.lastIndex += 1;
                  }
                  // NOTE: we deliberately do NOT call `registerSecret(raw)` on
                  // the ignored path. Doing so would pollute the
                  // `@actions/core` mask set with intentionally-suppressed
                  // values, and any subsequent log line containing those
                  // values would be masked even though the operator told us
                  // to ignore them. The ordinal counter has already advanced,
                  // so removing or adding an ignore entry doesn't shift the
                  // fingerprints of unrelated subsequent matches.
                  continue;
                }

                // Register the raw value with the redactor ONLY for findings
                // that will be surfaced. Critical ordering: register BEFORE
                // building any subsequent log line or rendered output that
                // might inadvertently contain the value.
                registerSecret(raw);
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

      return {
        scanner: SCANNER_ID,
        findings: suppressAwsBodyOverlapsWithPem(findings),
        errors,
        metrics: buildMetrics(started, files_examined, deps.cache.hit_count),
      };
    },
  };
}

/**
 * Post-scan dedup pass: drop `aws-secret-access-key` findings that fall within
 * ±20 lines of a `private-key-pem` finding on the SAME file.
 *
 * Why: the AWS-secret pattern `/(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/])/g`
 * plus the entropy gate happily matches the BODY lines of a PEM private-key
 * block (e.g. `MIIEpAIBAAKCAQEA3Ro...`) whenever a line happens to be exactly
 * 40 characters of base64. The `private-key-pem` pattern already fires on the
 * header `-----BEGIN ... PRIVATE KEY-----`, so without this pass a single
 * leaked PEM produces 1 PEM finding plus N AWS findings (one per ~40-char body
 * line) that are all the same underlying issue.
 *
 * Approach: collect the per-file set of PEM-header line numbers, then filter
 * AWS-secret findings whose `line` is within ±20 of any PEM header on that
 * file. 20 lines is generous enough to cover RSA-4096 PEMs (which produce
 * roughly 50 body lines at 64 chars each, but only a handful would be exactly
 * 40 chars after base64 wrapping) without being so wide that an unrelated AWS
 * key on the same file gets suppressed.
 *
 * Implementation note: PEM findings themselves are never suppressed — this is
 * a one-way suppression of the noisier AWS pattern. The function preserves
 * input order so the runner's deterministic ordering is unchanged.
 */
const PEM_AWS_DEDUP_WINDOW = 20;
function suppressAwsBodyOverlapsWithPem(
  findings: readonly ScanFinding[],
): ScanFinding[] {
  // Bucket PEM headers by file once so the AWS filter is O(N*K) per file
  // (K = PEM headers in that file, typically 0 or 1) instead of O(N²) overall.
  const pemLinesByFile = new Map<string, number[]>();
  for (const f of findings) {
    if (f.rule_id !== 'secret:private-key-pem') continue;
    const list = pemLinesByFile.get(f.file_path);
    if (list) list.push(f.line);
    else pemLinesByFile.set(f.file_path, [f.line]);
  }
  if (pemLinesByFile.size === 0) return [...findings];
  return findings.filter((f) => {
    if (f.rule_id !== 'secret:aws-secret-access-key') return true;
    const pemLines = pemLinesByFile.get(f.file_path);
    if (!pemLines) return true;
    for (const pemLine of pemLines) {
      if (Math.abs(f.line - pemLine) <= PEM_AWS_DEDUP_WINDOW) return false;
    }
    return true;
  });
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
