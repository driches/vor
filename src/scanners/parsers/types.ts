/**
 * Shared contract for lockfile parsers used by the dependency-cve scanner.
 *
 * Each parser handles exactly one lockfile format and returns a flat list of
 * (ecosystem, name, version, line) tuples. The scanner walks the changed-file
 * set, asks every parser whether it `matches(file)`, and then feeds matching
 * lockfile bodies into `parse(content)` to learn what packages got pinned.
 *
 * Failure mode: `parse()` MUST NOT throw. A lockfile with a malformed body
 * (corrupted JSON, a broken yarn record, a truncated YAML, etc.) should
 * resolve to `[]` so the rest of the scan still runs. The caller logs the
 * dropped file at warn level.
 */
import type { ChangedFile } from '../../types.js';

export interface ParsedDependency {
  /** v1 ecosystems supported by the dependency-cve scanner. */
  ecosystem: 'npm' | 'PyPI';
  name: string;
  version: string;
  /** 1-indexed line in the lockfile where this version is declared.
   *  Used as the inline-comment anchor for the finding. */
  line: number;
  /**
   * Optional 1-indexed line of the entry's HEADER (the package-selector
   * declaration), distinct from `line` (which points at the version body).
   * Only meaningful for Yarn-style lockfiles where a header like
   * `"react@^17.0.0", "some-other-selector":` can be added by a PR while
   * the body's `version "..."` stays unchanged. The dep-cve scanner uses
   * either `line` or `header_line` to decide "is this dep introduced by
   * this PR" so a header-only addition still triggers OSV scanning.
   * Parsers that have no header/body split (npm, pnpm, requirements)
   * leave this undefined.
   */
  header_line?: number;
}

export interface LockfileParser {
  ecosystem: ParsedDependency['ecosystem'];
  /** Does this parser handle this file? (by path/basename match) */
  matches(file: ChangedFile): boolean;
  /** Parse the lockfile content into dependencies. Returns [] on parse failure (logged elsewhere). */
  parse(content: string): ParsedDependency[];
}
