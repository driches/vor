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
  /** 1-indexed line in the lockfile where this version is declared. */
  line: number;
}

export interface LockfileParser {
  ecosystem: ParsedDependency['ecosystem'];
  /** Does this parser handle this file? (by path/basename match) */
  matches(file: ChangedFile): boolean;
  /** Parse the lockfile content into dependencies. Returns [] on parse failure (logged elsewhere). */
  parse(content: string): ParsedDependency[];
}
