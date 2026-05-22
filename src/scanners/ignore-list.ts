/**
 * Suppression list loaded from `.code-review/security-ignore.yml` (or whatever
 * path the user configured under `security.ignore_file`). Each entry targets a
 * specific class of scanner finding (CVE id, GHSA id, vulnerable package
 * range, or file+rule for secrets / SAST hits) and carries a required
 * justification plus optional expiry date.
 *
 * Failure mode: a malformed or missing ignore file MUST NOT crash the action.
 * `IgnoreList.load()` always returns a usable instance; parse failures degrade
 * to {@link IgnoreList.empty} with a logger.warn so the review still runs.
 *
 * Expired entries still match — `matches()` returns `expired: true` alongside
 * `ignored: true` so the runner can emit a notice annotation telling the
 * author their suppression is past its sell-by date.
 */
import { parse as parseYaml } from 'yaml';
import { satisfies as semverSatisfies, valid as semverValid } from 'semver';
import { z } from 'zod';
import type { FileReader } from '../github/file-reader.js';
import { GitHubApiError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import type {
  IgnoreList as IgnoreListContract,
  IgnoreMatchResult,
  ScanFinding,
} from './types.js';

/**
 * ISO date for the `expires` field. Accepts both bare `YYYY-MM-DD` strings
 * (yaml's default for unquoted dates) and explicit `!!timestamp` tagged values
 * (which yaml parses as `Date`). Also accepts RFC3339 datetime strings like
 * `2026-12-31T23:59:59Z` or `2026-12-31T23:59:59+02:00` so users pasting a
 * timestamp from another tool don't silently degrade their whole file. All
 * forms normalize to `YYYY-MM-DD` (UTC truncation for `Date` inputs;
 * leading-10-char slice for strings, which is correct in either timezone since
 * the date portion already starts the string).
 */
const isoDateSchema = z
  .union([
    z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
        'expires must be ISO YYYY-MM-DD or RFC3339 datetime',
      ),
    z.date(),
  ])
  .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10)));

const ghsaEntrySchema = z.object({
  ghsa_id: z.string().min(1),
  reason: z.string().min(1),
  expires: isoDateSchema.optional(),
});

const cveEntrySchema = z.object({
  cve_id: z.string().min(1),
  reason: z.string().min(1),
  expires: isoDateSchema.optional(),
});

const packageEntrySchema = z.object({
  package: z.object({
    name: z.string().min(1),
    ecosystem: z.string().min(1),
    version: z.string().min(1),
  }),
  reason: z.string().min(1),
  expires: isoDateSchema.optional(),
});

const fileRuleEntrySchema = z.object({
  file: z.string().min(1),
  rule: z.string().min(1),
  reason: z.string().min(1),
  expires: isoDateSchema.optional(),
});

/**
 * One ignore entry. Discriminated by which key is present; Zod's `union`
 * tries each variant in order. `ghsa_id` and `cve_id` are checked before the
 * package/file variants so a single entry with both a `ghsa_id` AND a stray
 * `package:` block still validates against the GHSA variant rather than
 * silently being interpreted as a package rule.
 */
const ignoreEntrySchema = z.union([
  ghsaEntrySchema,
  cveEntrySchema,
  packageEntrySchema,
  fileRuleEntrySchema,
]);

const ignoreFileSchema = z.object({
  entries: z.array(ignoreEntrySchema),
});

type IgnoreEntry = z.infer<typeof ignoreEntrySchema>;

function isGhsaEntry(e: IgnoreEntry): e is z.infer<typeof ghsaEntrySchema> {
  return 'ghsa_id' in e;
}
function isCveEntry(e: IgnoreEntry): e is z.infer<typeof cveEntrySchema> {
  return 'cve_id' in e;
}
function isPackageEntry(e: IgnoreEntry): e is z.infer<typeof packageEntrySchema> {
  return 'package' in e;
}
function isFileRuleEntry(e: IgnoreEntry): e is z.infer<typeof fileRuleEntrySchema> {
  return 'file' in e && 'rule' in e;
}

export interface IgnoreListLoadArgs {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export class IgnoreList implements IgnoreListContract {
  private constructor(private readonly entries: readonly IgnoreEntry[]) {}

  /** Empty list — matches nothing. */
  static empty(): IgnoreList {
    return new IgnoreList([]);
  }

  /**
   * Load the ignore file from the PR HEAD via {@link FileReader}. Any failure
   * (missing file, malformed YAML, schema violation) degrades to
   * {@link IgnoreList.empty} with a logger entry. We never throw — a typo in
   * the security file should NOT block a code review.
   */
  static async load(reader: FileReader, args: IgnoreListLoadArgs): Promise<IgnoreList> {
    let raw: string | null;
    try {
      raw = await reader.read({
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        ref: args.ref,
      });
    } catch (err) {
      const status =
        err instanceof GitHubApiError && err.status != null ? ` (status ${err.status})` : '';
      void logger.warn(
        `Failed to read ignore file ${args.path}@${args.ref}${status}: ${(err as Error).message}. Treating as empty.`,
      );
      return IgnoreList.empty();
    }

    if (raw == null || raw.trim().length === 0) {
      void logger.debug(`No ignore file at ${args.path}@${args.ref}; using empty list.`);
      return IgnoreList.empty();
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      void logger.warn(
        `Failed to parse ignore file ${args.path}: ${(err as Error).message}. Treating as empty.`,
      );
      return IgnoreList.empty();
    }

    if (parsed == null || typeof parsed !== 'object') {
      void logger.warn(
        `Ignore file ${args.path} did not parse to an object. Treating as empty.`,
      );
      return IgnoreList.empty();
    }

    const result = ignoreFileSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      void logger.warn(
        `Ignore file ${args.path} validation failed: ${detail}. Treating as empty.`,
      );
      return IgnoreList.empty();
    }

    return new IgnoreList(result.data.entries);
  }

  matches(finding: ScanFinding): IgnoreMatchResult {
    for (const entry of this.entries) {
      if (entryMatches(entry, finding)) {
        const expired = isExpired(entry.expires);
        return { ignored: true, expired, reason: entry.reason };
      }
    }
    return { ignored: false };
  }
}

/**
 * Match an ignore entry against a scanner finding. Each branch is tied to one
 * shape of {@link ScanEvidence}: CVE evidence drives ghsa/cve/package entries,
 * while file+rule entries match across any scanner kind (secrets, SAST, etc.)
 * via `finding.file_path` + `finding.rule_id`.
 */
function entryMatches(entry: IgnoreEntry, finding: ScanFinding): boolean {
  if (isGhsaEntry(entry)) {
    return (
      finding.evidence.kind === 'cve' && finding.evidence.ghsa_id === entry.ghsa_id
    );
  }
  if (isCveEntry(entry)) {
    return (
      finding.evidence.kind === 'cve' && finding.evidence.cve_id === entry.cve_id
    );
  }
  if (isPackageEntry(entry)) {
    if (finding.evidence.kind !== 'cve') return false;
    if (finding.evidence.ecosystem !== entry.package.ecosystem) return false;
    // npm and PyPI normalize package names case-insensitively at the registry:
    // `React@16.5.0` and `react@16.5.0` are the same dep. Lockfiles publish
    // lowercase but humans typing entries don't necessarily, so we normalize
    // both sides for those ecosystems before comparing. Other ecosystems
    // (Maven, etc.) keep case-sensitive matching.
    if (
      normalizePackageName(entry.package.name, entry.package.ecosystem) !==
      normalizePackageName(finding.evidence.package, finding.evidence.ecosystem)
    ) {
      return false;
    }
    return semverInRange(finding.evidence.affected_version, entry.package.version);
  }
  if (isFileRuleEntry(entry)) {
    // v1: exact path match only. Globs (e.g. minimatch) are intentionally
    // deferred — see Task 3 spec. If/when we need patterns like
    // `src/legacy/**` we'll add minimatch as a dep and update this branch.
    return finding.file_path === entry.file && finding.rule_id === entry.rule;
  }
  return false;
}

/**
 * Normalize a package name to match registry behavior. npm and PyPI are
 * case-insensitive (PyPI also dash/underscore-insensitive but that's not
 * handled here — out of scope for this fix); other ecosystems compare
 * verbatim.
 */
function normalizePackageName(name: string, ecosystem: string): string {
  if (ecosystem === 'npm' || ecosystem === 'PyPI') return name.toLowerCase();
  return name;
}

/**
 * Semver range check. Returns false (no match) rather than throwing on
 * invalid input — a bad version string in scanner output or a bad range in
 * the ignore file should not block other entries from matching. Both values
 * must be valid for a positive match.
 */
function semverInRange(version: string, range: string): boolean {
  if (semverValid(version) == null) return false;
  try {
    return semverSatisfies(version, range);
  } catch {
    return false;
  }
}

/**
 * `expires` is ISO YYYY-MM-DD (timezone-naive). We compare against the
 * current calendar date in UTC: an entry expiring 2026-12-31 still suppresses
 * findings up through 2026-12-31 UTC, and becomes "expired" on 2027-01-01.
 */
function isExpired(expires: string | undefined): boolean {
  if (expires == null) return false;
  const today = new Date().toISOString().slice(0, 10);
  // Lexicographic compare is correct for YYYY-MM-DD strings.
  return expires < today;
}
