/**
 * Core types and interfaces shared by every security scanner plugin.
 *
 * Scanners produce {@link ScanFinding}s that the runner converts into
 * {@link PostedComment}s alongside the agent's own findings. This file is
 * dependency-free w.r.t. concrete scanner classes: the cache and ignore-list
 * interfaces are forward-declared here so the implementation files can import
 * them without introducing a cycle.
 */
import type { Octokit } from '@octokit/rest';
import type { Category, ChangedFile, Confidence, ScannerId, Severity } from '../types.js';
import type { RepoContextEntry } from '../agent/system-prompt.js';
import type { SecurityConfig } from '../config/types.js';
import type { FileReader } from '../github/file-reader.js';

/**
 * A single security scanner plugin. The runner calls `applies()` cheaply on
 * every PR to decide whether to spin up `scan()`. `scan()` MUST NOT throw —
 * non-fatal errors should be appended to the result's `errors` array.
 */
export interface Scanner {
  readonly id: ScannerId;
  /** Cheap pre-check; skip scan() entirely when this returns false. */
  applies(files: readonly ChangedFile[]): boolean;
  scan(deps: ScannerDeps): Promise<ScanResult>;
}

/**
 * Dependencies handed to every scanner's `scan()`. Most fields are read-only
 * inputs; `cache` and `ignoreList` are mutable services with the contracts
 * defined below.
 */
export interface ScannerDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pull_number: number;
  /** The PR HEAD SHA — passed to `fileReader.read()` so scanners fetch the
   *  same revision the reviewable_lines and diff were computed against. */
  head_sha: string;
  changedFiles: readonly ChangedFile[];
  /** Same context files the system prompt uses — CLAUDE.md, package.json, etc. */
  contextFiles: readonly RepoContextEntry[];
  diff: string;
  workspaceDir: string;
  cache: ScanCache;
  ignoreList: IgnoreList;
  /** Reads files at the PR HEAD ref. Shared across scanners so a single fetch
   *  of e.g. a lockfile is reused via the reader's own LRU. */
  fileReader: FileReader;
  config: SecurityConfig;
  /** Aborts when the per-scanner timeout fires (or the orchestrator-level
   *  deadline elapses). Scanners doing network I/O MUST thread this through
   *  to fetch/HTTP-client calls so in-flight requests are cancelled rather
   *  than abandoned — abandoning them leaves the request running until its
   *  own timeout, consuming budget the runner has already given up on. */
  signal: AbortSignal;
}

/**
 * Minimal cache contract. The concrete in-memory implementation lives in
 * `./cache.ts`; this interface is here so scanners can depend on it without
 * importing the class.
 */
export interface ScanCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  readonly hit_count: number;
  readonly miss_count: number;
}

/**
 * Result of matching a finding against the repo's `.code-review/security-ignore.yml`.
 * Expired entries still suppress the finding (`ignored: true`) but set
 * `expired: true` so the runner can surface a "your ignore expired" notice
 * to the PR author.
 */
export interface IgnoreMatchResult {
  ignored: boolean;
  expired?: boolean;
  reason?: string;
}

/**
 * Forward declaration of the ignore-list service (lands in Task 3). Scanners
 * only need to call `matches()`; the concrete loader, parser, and TTL logic
 * are owned by the implementation.
 */
export interface IgnoreList {
  matches(finding: ScanFinding): IgnoreMatchResult;
}

/**
 * Provenance metadata attached to each {@link ScanFinding}. The shape is
 * scanner-kind-specific so downstream consumers (e.g. the comment formatter)
 * can render scanner-appropriate detail without inspecting the scanner id.
 */
export type ScanEvidence =
  | {
      kind: 'cve';
      cve_id?: string;
      ghsa_id?: string;
      osv_id: string;
      ecosystem: string;
      package: string;
      affected_version: string;
      fixed_version?: string;
      cvss?: number;
    }
  | { kind: 'secret'; masked_match: string; pattern_id: string }
  | { kind: 'sast'; cwe?: string[] }
  | {
      kind: 'container';
      base_image: string;
      tag: string;
      cve_ids: string[];
    };

/**
 * A single issue raised by a scanner. Pre-aggregation: it has not yet been
 * deduped against the agent's findings nor validated against `reviewable_lines`.
 */
export interface ScanFinding {
  scanner: ScannerId;
  rule_id: string;
  file_path: string;
  line: number;
  start_line?: number;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  suggestion?: string;
  confidence: Confidence;
  evidence: ScanEvidence;
  /** Stable identifier for dedup and ignore-list lookup. Generation strategy
   *  is scanner-specific (e.g. `${osv_id}:${package}:${file_path}`). */
  fingerprint: string;
}

/**
 * A non-fatal error from a scanner. The runner aggregates these and surfaces
 * them in the review summary. `fatal: false` is a structural marker: scanners
 * MUST NEVER raise — exceptions inside `scan()` indicate a runner bug.
 */
export interface ScanError {
  message: string;
  cause?: string;
  fatal: false;
}

export interface ScannerMetrics {
  duration_ms: number;
  files_examined: number;
  /**
   * Best-effort count of LOGICAL network operations the scanner initiated,
   * NOT a literal HTTP-request counter. Each scanner defines its own
   * accounting; `dependency-cve` for example counts OSV `queryBatch` chunks
   * accurately (1 per HTTP request) but counts `getVuln` per requested ID
   * (so transparent retries inside the OSV client are invisible here).
   * Operators monitoring spend or rate-limit risk should treat this as a
   * lower bound on actual HTTP traffic.
   */
  network_calls: number;
  cache_hits: number;
}

/**
 * Aggregated output from a single `scan()` call. The runner combines results
 * from every scanner before deduping and posting.
 */
export interface ScanResult {
  scanner: ScannerId;
  findings: ScanFinding[];
  errors: ScanError[];
  metrics: ScannerMetrics;
}

/**
 * Build an empty result for a scanner that opted out via `applies() === false`
 * (or completed with no findings). Centralised so the zero values stay in sync
 * with {@link ScannerMetrics}.
 */
export function emptyResult(scanner: ScannerId, durationMs = 0): ScanResult {
  return {
    scanner,
    findings: [],
    errors: [],
    metrics: {
      duration_ms: durationMs,
      files_examined: 0,
      network_calls: 0,
      cache_hits: 0,
    },
  };
}
