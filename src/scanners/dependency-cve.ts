/**
 * Concrete `Scanner` for finding known CVEs in lockfile dependencies.
 *
 * Pipeline per PR:
 *
 *   1. Filter the changed-file set through the 4 lockfile parsers (npm
 *      package-lock, yarn classic, pnpm, python requirements).
 *   2. Fetch each matching lockfile at HEAD via {@link FileReader} and parse
 *      it into a list of (ecosystem, name, version, line) tuples.
 *   3. Batch the (ecosystem, name, version) tuples through OSV's
 *      `/v1/querybatch`, keyed off a per-tuple cache so the same dep across
 *      multiple lockfiles is only queried once.
 *   4. For each hit, fetch full `OsvVuln` records (also cached) and map them
 *      to {@link ScanFinding}s — severity from CVSS / `database_specific`,
 *      evidence with CVE+GHSA aliases, deterministic fingerprint.
 *   5. Apply the {@link IgnoreList}, dropping matched findings and emitting
 *      a `logger.notice` for expired suppressions so the reviewer knows.
 *
 * Failure contract: this scanner MUST NOT throw. Network errors from OSV,
 * malformed lockfiles, or surprises from FileReader degrade to an empty
 * findings array with a populated `errors[]` per the {@link Scanner} contract.
 */
import { createHash } from 'node:crypto';
import { canonicalizePackageName } from './canonicalize.js';
import { npmPackageLockParser } from './parsers/npm-package-lock.js';
import { yarnLockParser } from './parsers/yarn-lock.js';
import { pnpmLockParser } from './parsers/pnpm-lock.js';
import { pythonRequirementsParser } from './parsers/python-requirements.js';
import type { LockfileParser, ParsedDependency } from './parsers/types.js';
import {
  createOsvClient,
  type OsvBatchHit,
  type OsvClient,
  type OsvQuery,
  type OsvVuln,
} from './osv-client.js';
import { logger as defaultLogger } from '../util/logger.js';

/**
 * Structural type for the logger we accept via DI. Mirrors the public surface
 * of `src/util/logger.ts#logger` so tests can stub it without dragging in
 * `@actions/core`. The narrower shape (only the methods this scanner uses)
 * keeps the dependency contract honest.
 */
export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;
import type { ChangedFile, ScannerId, Severity } from '../types.js';
import type {
  ScanError,
  ScanEvidence,
  ScanFinding,
  Scanner,
  ScannerDeps,
  ScannerMetrics,
  ScanResult,
} from './types.js';

const SCANNER_ID: ScannerId = 'dependency-cve';
/** Cap on the rendered `description` so very chatty advisories don't blow up
 *  the GitHub comment body. 300 chars fits comfortably in a PR comment without
 *  losing the gist; the OSV link is appended after the truncation. */
const DESCRIPTION_MAX_CHARS = 300;
/** Cap on the rendered title — GitHub truncates long PR-comment titles. The
 *  whole composed title (summary + ` in name@version`) must fit, otherwise we
 *  fall through to the boilerplate "<severity> vulnerability in name@version"
 *  form which is bounded by ecosystem reality. */
const TITLE_MAX_CHARS = 120;

const DEFAULT_PARSERS: readonly LockfileParser[] = [
  npmPackageLockParser,
  yarnLockParser,
  pnpmLockParser,
  pythonRequirementsParser,
];

export interface DependencyCveScannerOptions {
  /** Override the OSV client — primarily a DI hook for tests. */
  osvClient?: OsvClient;
  /** Override the parser set — primarily a DI hook for tests. */
  parsers?: readonly LockfileParser[];
  /** Override the logger — primarily a DI hook for tests. */
  logger?: Logger;
}

/**
 * Match a changed file against the parser set. Returns the FIRST parser whose
 * `matches()` accepts the file. Multiple parsers can theoretically match the
 * same path (e.g. someone named a file `requirements.txt` that happens to be
 * a yarn lock), but in practice the basename-based heuristics are disjoint —
 * if that assumption ever breaks, the first match wins.
 */
function findParser(
  file: ChangedFile,
  parsers: readonly LockfileParser[],
): LockfileParser | undefined {
  for (const p of parsers) {
    if (p.matches(file)) return p;
  }
  return undefined;
}

/**
 * Deterministic 12-char fingerprint over `${rule_id}:${package_name}:${version}:${file_path}`.
 * SHA-1 is fine here — this is not a security primitive, it's a stable
 * identifier for dedup and ignore-list lookup. 12 hex chars (~48 bits) is
 * enough collision resistance for a single PR.
 *
 * Note: `line` is intentionally NOT in the hash. Lockfile reorders (e.g. `npm
 * install` bumping an unrelated dep) shift line numbers without changing what
 * the finding is about — including `line` would break cross-PR continuity for
 * ignore-list pinning and dedup across re-pushes. The `line` field is still
 * carried on the `ScanFinding` for rendering.
 */
function fingerprintOf(
  rule_id: string,
  package_name: string,
  version: string,
  file_path: string,
): string {
  return createHash('sha1')
    .update(`${rule_id}:${package_name}:${version}:${file_path}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Pick the best CVE-XXXX-XXXX-* string out of an OSV `aliases` array, if any.
 * OSV uses uppercase prefixes; the check is case-insensitive to be charitable.
 */
function pickCveId(aliases: readonly string[] | undefined): string | undefined {
  if (!aliases) return undefined;
  return aliases.find((a) => /^CVE-/i.test(a));
}

/**
 * Pick the GHSA-* identifier from `aliases`, falling back to `id` when the
 * vuln record's primary id itself is a GHSA (the common case for npm CVEs).
 */
function pickGhsaId(vuln: OsvVuln): string | undefined {
  if (vuln.aliases) {
    const fromAlias = vuln.aliases.find((a) => /^GHSA-/i.test(a));
    if (fromAlias) return fromAlias;
  }
  if (/^GHSA-/i.test(vuln.id)) return vuln.id;
  return undefined;
}

/**
 * CVSS v3.0/v3.1 metric weight tables — direct from the official spec
 * (https://www.first.org/cvss/v3.1/specification-document, table A-1).
 * Privileges Required (PR) is scope-aware: a Changed scope swaps in higher
 * weights to reflect cross-component impact.
 */
const CVSS_V3_WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: {
    U: { N: 0.85, L: 0.62, H: 0.27 }, // Scope: Unchanged
    C: { N: 0.85, L: 0.68, H: 0.5 }, // Scope: Changed
  },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0.0 },
} as const;

type CvssV3MetricMap = Map<string, string>;

/**
 * Parse the metric portion of a CVSS vector string (everything after
 * `CVSS:3.x/`) into a map of metric → value. Returns null on syntactic
 * failure. Tolerant of trailing slashes and case.
 */
function parseCvssMetrics(metricPart: string): CvssV3MetricMap | null {
  const map: CvssV3MetricMap = new Map();
  for (const segment of metricPart.split('/')) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf(':');
    if (eq <= 0 || eq === segment.length - 1) return null;
    const key = segment.slice(0, eq).toUpperCase();
    const value = segment.slice(eq + 1).toUpperCase();
    map.set(key, value);
  }
  return map;
}

/** Round up to one decimal place per CVSS v3.1 spec §7.1. */
function cvssRoundUp(x: number): number {
  return Math.ceil(x * 10) / 10;
}

/**
 * Compute a CVSS v3.0/v3.1 base score from a parsed metric map. Returns
 * undefined if any required metric is missing or carries an unrecognized
 * value (defensive — partial vectors shouldn't silently coerce to a score).
 *
 * Formula follows the spec verbatim:
 *   ISS = 1 - (1-C)(1-I)(1-A)
 *   Impact = scope === 'U' ? 6.42 * ISS
 *                          : 7.52 * (ISS - 0.029) - 3.25 * (ISS - 0.02)^15
 *   Exploitability = 8.22 * AV * AC * PR * UI
 *   BaseScore = Impact <= 0 ? 0
 *             : scope === 'U' ? roundUp(min(Impact + Exploitability, 10))
 *                             : roundUp(min(1.08 * (Impact + Exploitability), 10))
 */
function computeCvssV3BaseScore(metrics: CvssV3MetricMap): number | undefined {
  const av = metrics.get('AV');
  const ac = metrics.get('AC');
  const pr = metrics.get('PR');
  const ui = metrics.get('UI');
  const scope = metrics.get('S');
  const c = metrics.get('C');
  const i = metrics.get('I');
  const a = metrics.get('A');
  if (
    av == null ||
    ac == null ||
    pr == null ||
    ui == null ||
    scope == null ||
    c == null ||
    i == null ||
    a == null
  ) {
    return undefined;
  }
  if (scope !== 'U' && scope !== 'C') return undefined;

  const avW = CVSS_V3_WEIGHTS.AV[av as keyof typeof CVSS_V3_WEIGHTS.AV];
  const acW = CVSS_V3_WEIGHTS.AC[ac as keyof typeof CVSS_V3_WEIGHTS.AC];
  const prTable = CVSS_V3_WEIGHTS.PR[scope];
  const prW = prTable[pr as keyof typeof prTable];
  const uiW = CVSS_V3_WEIGHTS.UI[ui as keyof typeof CVSS_V3_WEIGHTS.UI];
  const cW = CVSS_V3_WEIGHTS.CIA[c as keyof typeof CVSS_V3_WEIGHTS.CIA];
  const iW = CVSS_V3_WEIGHTS.CIA[i as keyof typeof CVSS_V3_WEIGHTS.CIA];
  const aW = CVSS_V3_WEIGHTS.CIA[a as keyof typeof CVSS_V3_WEIGHTS.CIA];

  if (
    avW == null ||
    acW == null ||
    prW == null ||
    uiW == null ||
    cW == null ||
    iW == null ||
    aW == null
  ) {
    return undefined;
  }

  const iss = 1 - (1 - cW) * (1 - iW) * (1 - aW);
  const impact =
    scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * avW * acW * prW * uiW;

  if (impact <= 0) return 0;
  const raw =
    scope === 'U'
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return cvssRoundUp(raw);
}

/**
 * Derive a numeric CVSS base score from an OSV severity `score` entry. OSV
 * publishes `score` as a CVSS vector string in practice (e.g.
 * `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`), but some advisories also
 * stamp the numeric value directly. We accept either:
 *
 *   - A bare numeric string in [0, 10] (fast path).
 *   - A CVSS v3.0 or v3.1 vector string — parsed and computed inline per the
 *     official formula. No external dep.
 *   - A CVSS v4.0 vector string — not supported in v1 (the v4 metric set and
 *     scoring formula are materially different and worth a separate pass);
 *     returns undefined so the caller falls back to `database_specific.severity`.
 *
 * Anything else is treated as "no numeric score available".
 */
function parseCvssScore(score: string): number | undefined {
  const trimmed = score.trim();
  if (trimmed.length === 0) return undefined;

  // Fast path: bare numeric. Avoid accepting an empty string (Number('') === 0).
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
    return undefined;
  }

  // Vector form. Detect the version prefix; we currently support 3.0 and 3.1.
  // 4.0 is intentionally NOT supported — its formula is materially different
  // and it's rare in OSV today. Returning undefined lets the caller fall
  // through to `database_specific.severity` which most v4-stamped advisories
  // also carry.
  const v3Match = /^CVSS:3\.[01]\/(.+)$/i.exec(trimmed);
  if (v3Match) {
    const metricPart = v3Match[1]!;
    const metrics = parseCvssMetrics(metricPart);
    if (metrics == null) return undefined;
    return computeCvssV3BaseScore(metrics);
  }

  return undefined;
}

/**
 * Extract the highest CVSS_V3 base score from `vuln.severity[]`, or undefined
 * if no parseable numeric severity is present. We prefer CVSS_V3/V4 over V2
 * when both are available; ties go to the highest number (a vuln can carry
 * multiple competing scores from different sources).
 *
 * Fall-through: `parseCvssScore` returns undefined for CVSS v4 vector
 * strings (we don't implement v4's base-score formula). If an advisory
 * publishes ONLY v3/v4 entries that don't yield a parseable score (e.g.
 * a single v4 vector), retry against the full severity list so a v2
 * score on the same advisory still drives severity routing. Without this
 * fallback such findings would drop to `database_specific.severity` /
 * default `important`, even when OSV had a usable score available.
 */
function highestCvssScore(vuln: OsvVuln): number | undefined {
  if (!vuln.severity || vuln.severity.length === 0) return undefined;
  const preferred = vuln.severity.filter(
    (s) => s.type === 'CVSS_V3' || s.type === 'CVSS_V4',
  );
  const best = highestParseable(preferred);
  if (best !== undefined) return best;
  // Preferred subset yielded nothing parseable — try the full list.
  return highestParseable(vuln.severity);
}

function highestParseable(
  entries: ReadonlyArray<{ type: string; score: string }>,
): number | undefined {
  let best: number | undefined;
  for (const s of entries) {
    const n = parseCvssScore(s.score);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

/**
 * Map a numeric CVSS base score to our `Severity` bucket. Boundaries follow
 * the standard CVSS v3 qualitative table (none/low/medium/high/critical),
 * collapsed onto our 4-level scale.
 *
 *   [9.0, 10] → critical
 *   [7.0, 9)  → important
 *   [4.0, 7)  → minor
 *   [0,   4)  → nit
 */
function severityFromCvss(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'important';
  if (score >= 4) return 'minor';
  return 'nit';
}

/**
 * Map the GHSA-style `database_specific.severity` string to our `Severity`
 * bucket. Inputs are normalized to upper-case; unknown values are ignored
 * (the caller falls back to the default).
 */
function severityFromDatabaseSpecific(s: string): Severity | undefined {
  switch (s.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'important';
    case 'MODERATE':
    case 'MEDIUM':
      return 'minor';
    case 'LOW':
      return 'nit';
    default:
      return undefined;
  }
}

interface DerivedSeverity {
  severity: Severity;
  cvss: number | undefined;
}

function deriveSeverity(vuln: OsvVuln): DerivedSeverity {
  const cvss = highestCvssScore(vuln);
  if (cvss != null) {
    return { severity: severityFromCvss(cvss), cvss };
  }
  const dbSpecific = vuln.database_specific?.severity;
  if (dbSpecific != null) {
    const mapped = severityFromDatabaseSpecific(dbSpecific);
    if (mapped != null) return { severity: mapped, cvss: undefined };
  }
  return { severity: 'important', cvss: undefined };
}

/**
 * Find the smallest `fixed` event across affected ranges for the given
 * (ecosystem, package). OSV publishes one or more `affected[]` blocks per
 * vuln; we only care about the one that matches the dep we just queried.
 * If multiple `fixed` events exist (e.g. backported fixes on multiple
 * branches), the FIRST one we encounter wins — we don't attempt semver
 * sorting in v1 because that requires a per-ecosystem comparator.
 */
function findFixedVersion(
  vuln: OsvVuln,
  ecosystem: string,
  pkg: string,
): string | undefined {
  if (!vuln.affected) return undefined;
  // Compare names via the shared per-ecosystem canonical form. For PyPI
  // this is PEP 503 (lowercase + `_`/`.`/`-` collapsed), so a lockfile
  // entry `zope.interface` matches an OSV advisory keyed on
  // `zope-interface`. npm gets case-insensitive matching. Without this
  // we silently drop the fixed-version hint for valid advisories.
  const wantedName = canonicalizePackageName(pkg, ecosystem);
  for (const a of vuln.affected) {
    if (!a.package) continue;
    if (a.package.ecosystem !== ecosystem) continue;
    if (canonicalizePackageName(a.package.name, ecosystem) !== wantedName) continue;
    if (!a.ranges) continue;
    for (const r of a.ranges) {
      for (const e of r.events) {
        if (typeof e.fixed === 'string' && e.fixed.length > 0) return e.fixed;
      }
    }
  }
  return undefined;
}

/**
 * Render the user-facing `description`. Prefers `details` (long-form prose)
 * over `summary` (one-liner). Truncated to a comment-friendly length, then
 * (when known) appended with the upgrade hint and the OSV link.
 *
 * Why the upgrade hint lives in `description` and not `suggestion`: GitHub
 * renders `suggestion` as a `​`​`​`suggestion` code block whose "Apply" button
 * literally replaces the target line. Since dependency-cve points at a
 * lockfile line (JSON/YAML/TOML), an English upgrade sentence cannot be a
 * safe code replacement — it would corrupt the lockfile if applied. So the
 * hint lives in prose where it belongs, and `suggestion` is omitted entirely
 * from these findings.
 */
function buildDescription(
  vuln: OsvVuln,
  fixed_version: string | undefined,
  pkg: string,
): string {
  const body = (vuln.details ?? vuln.summary ?? '').trim();
  const link = `https://osv.dev/vulnerability/${vuln.id}`;
  const upgrade = fixed_version != null ? ` Upgrade ${pkg} to >=${fixed_version} (or later).` : '';
  if (body.length === 0) return `See ${link} for details.${upgrade}`;
  if (body.length <= DESCRIPTION_MAX_CHARS) return `${body} (${link})${upgrade}`;
  // Reserve room for the ellipsis + link suffix; the upgrade hint is appended
  // after that since it's bounded and reviewer-relevant.
  const suffix = `… (${link})`;
  return `${body.slice(0, DESCRIPTION_MAX_CHARS - suffix.length)}${suffix}${upgrade}`;
}

/**
 * Concise comment title. Prefers the human-readable summary when present
 * because it's almost always more useful than "important vulnerability in
 * foo@1.2.3 (GHSA-...)" boilerplate.
 */
function buildTitle(
  vuln: OsvVuln,
  dep: ParsedDependency,
  severity: Severity,
  identifier: string,
): string {
  const tail = ` in ${dep.name}@${dep.version}`;
  const summary = vuln.summary?.trim();
  if (summary && summary.length > 0 && summary.length + tail.length <= TITLE_MAX_CHARS) {
    return `${summary}${tail}`;
  }
  return `${severity} vulnerability in ${dep.name}@${dep.version} (${identifier})`;
}

/** Internal record produced by the parsing+OSV-batch stage. */
interface ResolvedDep {
  /** PR-relative path of the lockfile this came from. */
  file_path: string;
  dep: ParsedDependency;
  /** OSV ids we resolved this dep to (post-batch). */
  vuln_ids: string[];
}

/**
 * Cache key for a single (ecosystem, name, version) lookup. Lowercased for
 * the name only — OSV's ecosystem strings are case-sensitive (`npm`, `PyPI`)
 * but package names are not — and we want `Lodash` and `lodash` to share a
 * cache slot when they reach OSV.
 */
function depCacheKey(ecosystem: string, name: string, version: string): string {
  // Cache key uses the canonical name too so `zope.interface` and
  // `zope-interface` don't get separate cache entries for the same OSV result.
  return `osv-batch:${ecosystem}:${canonicalizePackageName(name, ecosystem)}:${version}`;
}

function vulnCacheKey(id: string): string {
  return `osv-vuln:${id}`;
}

export function createDependencyCveScanner(
  options?: DependencyCveScannerOptions,
): Scanner {
  const parsers = options?.parsers ?? DEFAULT_PARSERS;
  // OSV client is constructed lazily so a scanner that never gets scheduled
  // (applies() === false) doesn't even allocate a fetch wrapper.
  let osvClient = options?.osvClient;
  function getOsvClient(): OsvClient {
    if (!osvClient) osvClient = createOsvClient();
    return osvClient;
  }
  const log = options?.logger ?? defaultLogger;

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      for (const f of files) {
        if (findParser(f, parsers) !== undefined) return true;
      }
      return false;
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;
      let network_calls = 0;

      // -----------------------------------------------------------------
      // Step 1+2: walk changed lockfiles, fetch + parse each.
      // -----------------------------------------------------------------
      const resolvedDeps: ResolvedDep[] = [];

      for (const file of deps.changedFiles) {
        const parser = findParser(file, parsers);
        if (parser == null) continue;

        let content: string | null;
        try {
          content = await deps.fileReader.read({
            owner: deps.owner,
            repo: deps.repo,
            path: file.path,
            ref: deps.head_sha,
          });
        } catch (err) {
          void log.warn(
            `dependency-cve: failed to read ${file.path}@${deps.head_sha}: ${(err as Error).message}`,
          );
          errors.push({
            message: `Failed to read lockfile ${file.path}`,
            cause: (err as Error).message,
            fatal: false,
          });
          continue;
        }
        if (content == null || content.length === 0) {
          void log.debug(`dependency-cve: ${file.path} missing or empty at HEAD; skipping`);
          continue;
        }

        files_examined += 1;
        const parsed = parser.parse(content);
        if (parsed.length === 0) {
          void log.debug(
            `dependency-cve: parser returned no deps for ${file.path} (malformed?)`,
          );
          continue;
        }

        // Only query OSV for deps that sit on lines this PR actually added.
        // The orchestrator later validates findings against reviewable_lines
        // and drops anything outside it — but OSV queries for non-added deps
        // still consume the 60s scanner budget. On large lockfiles (10k+
        // packages) that exhausts the budget and we lose findings for the
        // deps that ARE on added lines. Filter early.
        //
        // For lockfile formats with a header/body split (yarn), the parser
        // also exposes `header_line`. A PR can add a new selector to the
        // header while the body's `version "..."` stays unchanged — that
        // still introduces a new dep route, so we accept the dep if EITHER
        // line is added.
        const inDiff = parsed.filter(
          (d) =>
            file.added_lines.has(d.line) ||
            (d.header_line !== undefined && file.added_lines.has(d.header_line)),
        );
        if (inDiff.length === 0) {
          void log.debug(
            `dependency-cve: ${file.path} parsed ${parsed.length} dep(s) but none on added lines; skipping`,
          );
          continue;
        }

        for (const dep of inDiff) {
          resolvedDeps.push({ file_path: file.path, dep, vuln_ids: [] });
        }
      }

      if (resolvedDeps.length === 0) {
        return {
          scanner: SCANNER_ID,
          findings: [],
          errors,
          metrics: buildMetrics(started, files_examined, network_calls, deps.cache.hit_count),
        };
      }

      // -----------------------------------------------------------------
      // Step 3: batch + cache OSV queries.
      // -----------------------------------------------------------------
      // First, consult the cache. Group by (ecosystem,name,version) so the
      // same dep across two lockfiles only contributes one OSV query.
      const queriesToFetch: OsvQuery[] = [];
      const queryIndex = new Map<string, number>(); // key → index into queriesToFetch
      // Stash cache hits up front so we don't refetch them.
      for (const r of resolvedDeps) {
        const key = depCacheKey(r.dep.ecosystem, r.dep.name, r.dep.version);
        const hit = deps.cache.get<OsvBatchHit>(key);
        if (hit !== undefined) {
          r.vuln_ids = hit.vulns?.map((v) => v.id) ?? [];
          continue;
        }
        if (!queryIndex.has(key)) {
          queryIndex.set(key, queriesToFetch.length);
          queriesToFetch.push({
            package: { name: r.dep.name, ecosystem: r.dep.ecosystem },
            version: r.dep.version,
          });
        }
      }

      // Issue the batch (if any uncached queries remain). Errors here go into
      // `errors[]` and we bail with whatever we already resolved from cache.
      if (queriesToFetch.length > 0) {
        try {
          const resp = await getOsvClient().queryBatch(queriesToFetch, {
            signal: deps.signal,
          });
          // The OSV client splits queries internally at 100 per HTTP request,
          // so PRs touching >100 unique deps still incur multiple round-trips
          // even though we call queryBatch once. Mirror that batching here so
          // network_calls reflects actual HTTP traffic.
          const OSV_QUERY_BATCH_LIMIT = 100;
          network_calls += Math.ceil(queriesToFetch.length / OSV_QUERY_BATCH_LIMIT);
          // Stitch results back to their cache keys + resolved deps.
          for (const [key, idx] of queryIndex) {
            const hit = resp.results[idx] ?? {};
            deps.cache.set<OsvBatchHit>(key, hit);
          }
          for (const r of resolvedDeps) {
            if (r.vuln_ids.length > 0) continue; // already filled from cache
            const key = depCacheKey(r.dep.ecosystem, r.dep.name, r.dep.version);
            const cached = deps.cache.get<OsvBatchHit>(key);
            r.vuln_ids = cached?.vulns?.map((v) => v.id) ?? [];
          }
        } catch (err) {
          // Don't bail entirely — some `resolvedDeps` may already have
          // `vuln_ids` from the cache-hit pass above. Discarding them
          // hides findings that ARE resolvable just because the
          // uncached-deps batch round-trip failed. Record the error and
          // proceed to Step 4 with whatever cache hits we have.
          void log.warn(
            `dependency-cve: OSV batch query failed: ${(err as Error).message}. Proceeding with cache-hit findings only.`,
          );
          errors.push({
            message: 'OSV batch query failed (cache-only fallback)',
            cause: (err as Error).message,
            fatal: false,
          });
        }
      }

      // -----------------------------------------------------------------
      // Step 4: fetch full vuln records + map to findings.
      // -----------------------------------------------------------------
      // Collect the unique vuln-id set so we only `getVuln()` once per id.
      const uniqueVulnIds = new Set<string>();
      for (const r of resolvedDeps) {
        for (const id of r.vuln_ids) uniqueVulnIds.add(id);
      }

      // Fetch full vuln records in PARALLEL. Sequential awaits here would
      // stack: a lockfile with N CVEs makes N sequential HTTP round-trips,
      // exhausting the 60s scanner timeout on large lockfiles. `Promise.all`
      // is the simplest win; we keep error isolation by per-promise catch so
      // one bad id doesn't reject the whole batch.
      const vulnRecords = new Map<string, OsvVuln>();
      const idsToFetch: string[] = [];
      for (const id of uniqueVulnIds) {
        const cacheKey = vulnCacheKey(id);
        const cached = deps.cache.get<OsvVuln>(cacheKey);
        if (cached !== undefined) {
          vulnRecords.set(id, cached);
          continue;
        }
        idsToFetch.push(id);
      }
      if (idsToFetch.length > 0) {
        // Each entry resolves to { id, ok: true, vuln } or { id, ok: false, error }.
        // Bundling the id with the result keeps the loop below simple and avoids
        // ordering assumptions about Promise.all output (which IS index-stable
        // but the explicit id makes failure handling self-evident).
        type FetchOutcome =
          | { id: string; ok: true; vuln: OsvVuln }
          | { id: string; ok: false; error: Error };
        const outcomes = await Promise.all(
          idsToFetch.map(async (id): Promise<FetchOutcome> => {
            try {
              const vuln = await getOsvClient().getVuln(id, { signal: deps.signal });
              return { id, ok: true, vuln };
            } catch (err) {
              return { id, ok: false, error: err as Error };
            }
          }),
        );
        for (const outcome of outcomes) {
          if (outcome.ok) {
            network_calls += 1;
            deps.cache.set<OsvVuln>(vulnCacheKey(outcome.id), outcome.vuln);
            vulnRecords.set(outcome.id, outcome.vuln);
          } else {
            void log.warn(
              `dependency-cve: OSV getVuln(${outcome.id}) failed: ${outcome.error.message}`,
            );
            errors.push({
              message: `OSV getVuln(${outcome.id}) failed`,
              cause: outcome.error.message,
              fatal: false,
            });
            // Don't bail — other vulns may still produce findings.
          }
        }
      }

      // -----------------------------------------------------------------
      // Step 5: per (file, dep, vuln), build a finding and apply ignore-list.
      // -----------------------------------------------------------------
      for (const r of resolvedDeps) {
        for (const id of r.vuln_ids) {
          const vuln = vulnRecords.get(id);
          if (vuln == null) continue; // getVuln() failed for this id

          const finding = buildFinding(r, vuln);
          const match = deps.ignoreList.matches(finding);
          if (match.ignored) {
            if (match.expired) {
              void log.notice(
                `dependency-cve: ignore entry for ${finding.rule_id} (${finding.file_path}:${finding.line}) is expired; finding still suppressed but will need refresh. Reason: ${match.reason ?? '(no reason)'}`,
              );
            }
            continue;
          }
          findings.push(finding);
        }
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: buildMetrics(started, files_examined, network_calls, deps.cache.hit_count),
      };
    },
  };
}

function buildMetrics(
  started: number,
  files_examined: number,
  network_calls: number,
  cache_hits: number,
): ScannerMetrics {
  return {
    duration_ms: Date.now() - started,
    files_examined,
    network_calls,
    cache_hits,
  };
}

/**
 * Combine a resolved dependency + an OSV vuln record into a posted
 * {@link ScanFinding}. Pure function for testability.
 */
function buildFinding(r: ResolvedDep, vuln: OsvVuln): ScanFinding {
  const cve_id = pickCveId(vuln.aliases);
  const ghsa_id = pickGhsaId(vuln);
  const { severity, cvss } = deriveSeverity(vuln);
  const fixed_version = findFixedVersion(vuln, r.dep.ecosystem, r.dep.name);
  const rule_id = `osv:${vuln.id}`;
  // Prefer the CVE id in the title when available — that's the form most
  // reviewers can paste straight into NVD or their org's vuln tracker.
  const identifier = cve_id ?? ghsa_id ?? vuln.id;

  const evidence: ScanEvidence = {
    kind: 'cve',
    osv_id: vuln.id,
    ecosystem: r.dep.ecosystem,
    package: r.dep.name,
    affected_version: r.dep.version,
    ...(cve_id !== undefined ? { cve_id } : {}),
    ...(ghsa_id !== undefined ? { ghsa_id } : {}),
    ...(fixed_version !== undefined ? { fixed_version } : {}),
    ...(cvss !== undefined ? { cvss } : {}),
  };

  // No `suggestion` field — GitHub renders it as a literal code replacement,
  // which would corrupt a lockfile if applied. Upgrade hint lives in
  // `description` (see `buildDescription` for the rationale).
  const finding: ScanFinding = {
    scanner: SCANNER_ID,
    rule_id,
    file_path: r.file_path,
    line: r.dep.line,
    severity,
    category: 'vulnerability',
    title: buildTitle(vuln, r.dep, severity, identifier),
    description: buildDescription(vuln, fixed_version, r.dep.name),
    confidence: 'high',
    evidence,
    fingerprint: fingerprintOf(rule_id, r.dep.name, r.dep.version, r.file_path),
  };

  return finding;
}
