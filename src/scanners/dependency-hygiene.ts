/**
 * Concrete `Scanner` for supply-chain hygiene on npm manifests.
 *
 * Three deterministic checks, all derived from the PR's own diff plus the
 * `package.json` at HEAD — no OSV/network calls, no external binary:
 *
 *   1. **lockfile-drift** — a `package.json` dependency line changed but the
 *      PR touches no lockfile. Either the author forgot to run install (so
 *      `npm ci` will fail in CI) or the lockfile is out of sync.
 *   2. **non-registry-source** — a dependency points at a git/url/file source
 *      rather than the registry. These bypass the lockfile-integrity and CVE
 *      story and are a classic supply-chain foothold; worth a human's eyes.
 *   3. **unpinned-range** — a newly added dependency uses an open-ended or
 *      wildcard range (`*`, `latest`, `>=…`), which makes builds
 *      non-deterministic.
 *
 * Why JSON-parse the manifest instead of regexing the diff: a bare
 * `"name": "value"` line is ambiguous (it could be `scripts`, `engines`, the
 * package's own `version`, …). We parse `package.json` at HEAD to get the
 * AUTHORITATIVE set of dependency (name → spec) pairs, then only act on
 * `added_lines` whose `"name": "spec"` text matches a real dependency entry.
 * That eliminates the section-guessing false positives entirely.
 *
 * Failure contract: MUST NOT throw. A manifest that fails to read or parse
 * degrades to an empty result with a populated `errors[]`.
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
import type { ChangedFile, ScannerId } from '../types.js';

const SCANNER_ID: ScannerId = 'dependency-hygiene';

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface DependencyHygieneScannerOptions {
  logger?: Logger;
}

const MANIFEST_BASENAME = 'package.json';
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/** The four dependency maps npm honours, in a stable order. */
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** A JSON object line: `"name": "spec"` with an optional trailing comma. */
const JSON_PAIR_RE = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

/** git/url/file/scm sources — anything that isn't the public npm registry. */
const NON_REGISTRY_SPEC_RE = /^(?:git(?:\+|:|@)|https?:|github:|gitlab:|bitbucket:|file:)/i;

function isManifest(file: ChangedFile): boolean {
  return !file.is_generated && path.basename(file.path) === MANIFEST_BASENAME;
}

function isLockfile(file: ChangedFile): boolean {
  return LOCKFILE_BASENAMES.has(path.basename(file.path));
}

/** POSIX directory of a repo-relative path; `''` for a root-level file. */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Does a changed lockfile cover the given manifest? A lockfile covers a
 * manifest when it sits in the same directory OR an ancestor directory:
 *
 *   - A standalone package keeps its lockfile alongside `package.json`.
 *   - npm/yarn/pnpm workspaces keep a SINGLE lockfile at the repo root that
 *     covers every nested `package.json`, so a root lockfile (dir `''`)
 *     covers all manifests.
 *
 * Scoping per-manifest (rather than a repo-wide "any lockfile touched"
 * boolean) means that, in a monorepo, changing `packages/api/package.json`
 * while only `examples/package-lock.json` is touched still reports drift for
 * `packages/api` — the unrelated lockfile doesn't suppress it.
 */
function lockfileCoversManifest(lockPath: string, manifestPath: string): boolean {
  const lockDir = dirOf(lockPath);
  if (lockDir === '') return true; // root lockfile covers every manifest
  const manifestDir = dirOf(manifestPath);
  return manifestDir === lockDir || manifestDir.startsWith(`${lockDir}/`);
}

/**
 * Classify a version spec. Returns the rule id to fire, or null when the spec
 * is a normal pinned/caret/tilde range that needs no comment.
 */
function classifySpec(spec: string): 'non-registry-source' | 'unpinned-range' | null {
  const s = spec.trim();
  if (NON_REGISTRY_SPEC_RE.test(s)) return 'non-registry-source';
  // `npm:` aliases and `workspace:`/`link:` protocols still resolve through a
  // registry/lockfile, so they are not flagged as non-registry sources.
  if (s === '' || s === '*' || s.toLowerCase() === 'latest' || s.toLowerCase() === 'x') {
    return 'unpinned-range';
  }
  // Open-ended comparators (`>=1`, `>1`, `<2`, `<=2`) have no upper bound and
  // make installs non-deterministic. Caret/tilde/exact are fine.
  if (/^\s*(?:>=?|<=?)/.test(s)) return 'unpinned-range';
  return null;
}

/** Parse `package.json` text into a name → spec map across all dep sections. */
function parseDependencyMap(content: string): Map<string, string> | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  const out = new Map<string, string>();
  const root = json as Record<string, unknown>;
  for (const section of DEPENDENCY_SECTIONS) {
    const block = root[section];
    if (block === null || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec === 'string') out.set(name, spec);
    }
  }
  return out;
}

function fingerprintOf(rule_id: string, file_path: string, discriminator: string): string {
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${discriminator}`)
    .digest('hex')
    .slice(0, 12);
}

export function createDependencyHygieneScanner(
  options: DependencyHygieneScannerOptions = {},
): Scanner {
  const log = options.logger ?? defaultLogger;

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      return files.some(isManifest);
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;

      const changedLockfiles = deps.changedFiles.filter(isLockfile);

      for (const file of deps.changedFiles) {
        if (!isManifest(file)) continue;

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
            `dependency-hygiene: failed to read ${file.path}@${deps.head_sha}: ${(err as Error).message}`,
          );
          errors.push({
            message: `Failed to read manifest ${file.path}`,
            cause: (err as Error).message,
            fatal: false,
          });
          continue;
        }
        if (content === null || content.length === 0) {
          void log.debug(`dependency-hygiene: ${file.path} missing or empty at HEAD; skipping`);
          continue;
        }

        const depMap = parseDependencyMap(content);
        if (depMap === null) {
          void log.debug(`dependency-hygiene: ${file.path} did not parse as JSON; skipping`);
          continue;
        }
        files_examined += 1;

        // Walk only the lines this PR added. For each one that is a real
        // dependency entry (its `"name": "spec"` matches the parsed map),
        // run the per-dep classifiers and remember the first such line so a
        // lockfile-drift finding has somewhere to attach.
        let firstChangedDepLine: number | undefined;
        for (const lineNo of [...file.added_lines].sort((a, b) => a - b)) {
          const text = file.head_line_text.get(lineNo);
          if (text === undefined) continue;
          const m = JSON_PAIR_RE.exec(text);
          if (m === null) continue;
          const name = m[1]!;
          const spec = m[2]!;
          if (depMap.get(name) !== spec) continue; // not a dependency entry

          if (firstChangedDepLine === undefined) firstChangedDepLine = lineNo;

          const kind = classifySpec(spec);
          if (kind === null) continue;
          const finding = buildSpecFinding(file.path, lineNo, name, spec, kind);
          pushUnlessIgnored(finding, deps, findings, log, 'dependency-hygiene');
        }

        // lockfile-drift: dependency lines changed but no lockfile covering
        // THIS manifest (same dir or an ancestor) was updated in the PR.
        const lockfileCovered = changedLockfiles.some((lf) =>
          lockfileCoversManifest(lf.path, file.path),
        );
        if (firstChangedDepLine !== undefined && !lockfileCovered) {
          const rule_id = 'dependency-hygiene:lockfile-drift';
          const finding: ScanFinding = {
            scanner: SCANNER_ID,
            rule_id,
            file_path: file.path,
            line: firstChangedDepLine,
            severity: 'minor',
            category: 'bug',
            confidence: 'medium',
            title: `Dependency change without a lockfile update (${path.basename(file.path)})`,
            description:
              'This PR changes a dependency in `package.json` but does not update a lockfile ' +
              '(`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`). `npm ci` and reproducible ' +
              'installs require the lockfile to match the manifest — run your package manager ' +
              'install and commit the updated lockfile.',
            evidence: { kind: 'dependency', issue: 'lockfile-drift' },
            fingerprint: fingerprintOf(rule_id, file.path, 'drift'),
          };
          pushUnlessIgnored(finding, deps, findings, log, 'dependency-hygiene');
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

function buildSpecFinding(
  file_path: string,
  line: number,
  name: string,
  spec: string,
  kind: 'non-registry-source' | 'unpinned-range',
): ScanFinding {
  const rule_id = `dependency-hygiene:${kind}`;
  const base = {
    scanner: SCANNER_ID,
    rule_id,
    file_path,
    line,
    confidence: 'high' as const,
    evidence: { kind: 'dependency' as const, issue: kind, package: name, spec },
    fingerprint: fingerprintOf(rule_id, file_path, name),
  };
  if (kind === 'non-registry-source') {
    return {
      ...base,
      severity: 'important',
      category: 'security',
      confidence: 'high',
      title: `Dependency "${name}" is installed from a non-registry source`,
      description:
        `\`${name}\` resolves to \`${spec}\`, a git/URL/file source rather than the npm registry. ` +
        'Non-registry dependencies skip lockfile integrity and CVE scanning and are a common ' +
        'supply-chain vector. Confirm the source is trusted and pinned to an immutable ref ' +
        '(a commit SHA, not a branch).',
    };
  }
  return {
    ...base,
    severity: 'minor',
    category: 'architecture',
    confidence: 'medium',
    title: `Dependency "${name}" uses an unpinned version range`,
    description:
      `\`${name}\` is declared as \`${spec || '(empty)'}\`, an open-ended or wildcard range. ` +
      'This makes installs non-deterministic — a future release can change behavior without a ' +
      'code change. Pin to a caret/tilde range or an exact version.',
  };
}

/** Apply the ignore-list and push the finding unless suppressed. */
function pushUnlessIgnored(
  finding: ScanFinding,
  deps: ScannerDeps,
  out: ScanFinding[],
  log: Logger,
  scannerLabel: string,
): void {
  const match = deps.ignoreList.matches(finding);
  if (!match.ignored) {
    out.push(finding);
    return;
  }
  if (match.expired) {
    void log.notice(
      `${scannerLabel}: ignore entry for ${finding.rule_id} (${finding.file_path}:${finding.line}) is expired; finding still suppressed but will need refresh. Reason: ${match.reason ?? '(no reason)'}`,
    );
  }
}

function buildMetrics(started: number, files_examined: number): ScannerMetrics {
  return {
    duration_ms: Date.now() - started,
    files_examined,
    // File reads go through the shared FileReader LRU; like dependency-cve we
    // don't count those as logical network operations (only third-party API
    // calls such as OSV are counted, of which this scanner makes none).
    network_calls: 0,
    cache_hits: 0,
  };
}
