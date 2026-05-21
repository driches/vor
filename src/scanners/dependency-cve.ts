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
 * Deterministic 12-char fingerprint over `${file_path}:${line}:${rule_id}`.
 * SHA-1 is fine here — this is not a security primitive, it's a stable
 * identifier for dedup and ignore-list lookup. 12 hex chars (~48 bits) is
 * enough collision resistance for a single PR.
 */
function fingerprintOf(file_path: string, line: number, rule_id: string): string {
  return createHash('sha1').update(`${file_path}:${line}:${rule_id}`).digest('hex').slice(0, 12);
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
 * Try to derive a numeric CVSS base score from an OSV severity entry. OSV
 * publishes `score` as a CVSS vector string in practice (e.g.
 * `CVSS:3.1/AV:N/...`), but some advisories also stamp the numeric value
 * directly. We accept either form: a parseable float in [0,10] wins; anything
 * else is treated as "no numeric score available" and the caller falls back
 * to `database_specific.severity`.
 */
function parseNumericCvss(score: string): number | undefined {
  // Strip a leading "CVSS:" tag if the score is "9.1" or "3.1/AV:..." style.
  // We only want to succeed when the input cleanly parses as a single number.
  const trimmed = score.trim();
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  return undefined;
}

/**
 * Extract the highest CVSS_V3 base score from `vuln.severity[]`, or undefined
 * if no parseable numeric severity is present. We prefer CVSS_V3/V4 over V2
 * when both are available; ties go to the highest number (a vuln can carry
 * multiple competing scores from different sources).
 */
function highestCvssScore(vuln: OsvVuln): number | undefined {
  if (!vuln.severity || vuln.severity.length === 0) return undefined;
  // Prefer V3/V4 entries; V2 is mostly historical and shouldn't drive routing.
  const v3 = vuln.severity.filter((s) => s.type === 'CVSS_V3' || s.type === 'CVSS_V4');
  const candidates = v3.length > 0 ? v3 : vuln.severity;
  let best: number | undefined;
  for (const s of candidates) {
    const n = parseNumericCvss(s.score);
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
  for (const a of vuln.affected) {
    if (!a.package) continue;
    if (a.package.ecosystem !== ecosystem || a.package.name !== pkg) continue;
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
 * over `summary` (one-liner). Truncated to a comment-friendly length and
 * suffixed with an OSV link so the reviewer can drill in.
 */
function buildDescription(vuln: OsvVuln): string {
  const body = (vuln.details ?? vuln.summary ?? '').trim();
  const link = `https://osv.dev/vulnerability/${vuln.id}`;
  if (body.length === 0) return `See ${link} for details.`;
  if (body.length <= DESCRIPTION_MAX_CHARS) return `${body} (${link})`;
  // Reserve room for the ellipsis + link suffix.
  const suffix = `… (${link})`;
  return `${body.slice(0, DESCRIPTION_MAX_CHARS - suffix.length)}${suffix}`;
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
  const summary = vuln.summary?.trim();
  if (summary && summary.length > 0 && summary.length <= 120) {
    return `${summary} in ${dep.name}@${dep.version}`;
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
  return `osv-batch:${ecosystem}:${name.toLowerCase()}:${version}`;
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

        for (const dep of parsed) {
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
          const resp = await getOsvClient().queryBatch(queriesToFetch);
          network_calls += 1;
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
          void log.warn(
            `dependency-cve: OSV batch query failed: ${(err as Error).message}`,
          );
          errors.push({
            message: 'OSV batch query failed',
            cause: (err as Error).message,
            fatal: false,
          });
          return {
            scanner: SCANNER_ID,
            findings: [],
            errors,
            metrics: buildMetrics(
              started,
              files_examined,
              network_calls,
              deps.cache.hit_count,
            ),
          };
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

      const vulnRecords = new Map<string, OsvVuln>();
      for (const id of uniqueVulnIds) {
        const cacheKey = vulnCacheKey(id);
        const cached = deps.cache.get<OsvVuln>(cacheKey);
        if (cached !== undefined) {
          vulnRecords.set(id, cached);
          continue;
        }
        try {
          const fetched = await getOsvClient().getVuln(id);
          network_calls += 1;
          deps.cache.set<OsvVuln>(cacheKey, fetched);
          vulnRecords.set(id, fetched);
        } catch (err) {
          void log.warn(
            `dependency-cve: OSV getVuln(${id}) failed: ${(err as Error).message}`,
          );
          errors.push({
            message: `OSV getVuln(${id}) failed`,
            cause: (err as Error).message,
            fatal: false,
          });
          // Don't return — other vulns may still produce findings.
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

  const finding: ScanFinding = {
    scanner: SCANNER_ID,
    rule_id,
    file_path: r.file_path,
    line: r.dep.line,
    severity,
    category: 'vulnerability',
    title: buildTitle(vuln, r.dep, severity, identifier),
    description: buildDescription(vuln),
    confidence: 'high',
    evidence,
    fingerprint: fingerprintOf(r.file_path, r.dep.line, rule_id),
    ...(fixed_version !== undefined
      ? { suggestion: `Upgrade ${r.dep.name} to >=${fixed_version}.` }
      : {}),
  };

  return finding;
}
