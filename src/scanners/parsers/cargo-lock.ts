/**
 * Parser for `Cargo.lock` (Rust / crates.io).
 *
 * Cargo.lock is TOML, an array of `[[package]]` tables:
 *
 *   [[package]]
 *   name = "regex"
 *   version = "1.10.2"
 *   source = "registry+https://github.com/rust-lang/crates.io-index"
 *   checksum = "..."
 *
 * We line-scan rather than pull in a TOML dependency — the block shape is
 * regular, and a textual scan is what gives us the source-line anchor for the
 * inline comment anyway (same approach as the pnpm and go.sum parsers). Only
 * `name`, `version`, and `source` are read; `dependencies = [...]` inline
 * arrays and `checksum` lines are ignored because they never match the
 * top-level key regexes.
 *
 * Only packages resolved from crates.io are reported. A package with no
 * `source` is a local path/workspace member, and `source = "git+…"` is a git
 * dependency — neither has a crates.io version OSV could answer for, so both
 * are skipped (mirroring how the go.sum parser skips modules whose code never
 * ships from the registry).
 *
 * Anchoring: the finding sits on the `version = "…"` line, not `name`. An
 * in-place version bump only touches the `version` line, so anchoring there is
 * what lets the dep-cve scanner's added-line filter see the change; anchoring
 * on the (unchanged) `name` line would miss it.
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

const CRATES_IO_SOURCE_PREFIX = 'registry+https://github.com/rust-lang/crates.io-index';

const NAME_RE = /^name = "(.*)"$/;
const VERSION_RE = /^version = "(.*)"$/;
const SOURCE_RE = /^source = "(.*)"$/;

class CargoLockParser implements LockfileParser {
  readonly ecosystem = 'crates.io' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'Cargo.lock';
  }

  parse(content: string): ParsedDependency[] {
    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    let name: string | undefined;
    let version: string | undefined;
    let versionLine: number | undefined;
    let source: string | undefined;
    let inPackage = false;

    const flush = (): void => {
      if (
        name !== undefined &&
        version !== undefined &&
        versionLine !== undefined &&
        source !== undefined &&
        source.startsWith(CRATES_IO_SOURCE_PREFIX)
      ) {
        out.push({ ecosystem: 'crates.io', name, version, line: versionLine });
      }
      name = version = source = undefined;
      versionLine = undefined;
    };

    for (let i = 0; i < lines.length; i++) {
      const t = (lines[i] ?? '').trim();
      if (t === '[[package]]') {
        flush();
        inPackage = true;
        continue;
      }
      // Any other TOML table header ([metadata], [[patch.unused]], …) ends the
      // current package block.
      if (t.startsWith('[')) {
        flush();
        inPackage = false;
        continue;
      }
      if (!inPackage) continue;

      const nameMatch = t.match(NAME_RE);
      if (nameMatch) {
        name = nameMatch[1];
        continue;
      }
      const versionMatch = t.match(VERSION_RE);
      if (versionMatch) {
        version = versionMatch[1];
        versionLine = i + 1;
        continue;
      }
      const sourceMatch = t.match(SOURCE_RE);
      if (sourceMatch) source = sourceMatch[1];
    }
    flush();

    return out;
  }
}

export const cargoLockParser: LockfileParser = new CargoLockParser();
