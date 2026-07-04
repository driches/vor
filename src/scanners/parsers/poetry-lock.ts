/**
 * Parser for `poetry.lock` (Python / PyPI).
 *
 * poetry.lock is TOML, an array of `[[package]]` tables:
 *
 *   [[package]]
 *   name = "requests"
 *   version = "2.31.0"
 *   description = "Python HTTP for Humans."
 *   optional = false
 *   python-versions = ">=3.7"
 *
 *   [package.dependencies]
 *   certifi = ">=2017.4.17"
 *
 * We line-scan rather than pull in a TOML dependency (same rationale as the
 * Cargo.lock parser). `name`/`version` are read only from the package's
 * top-level key section — the lines before any `[package.*]` sub-table — so a
 * dependency constraint that happens to be named `version` inside
 * `[package.dependencies]` can't be mistaken for the package's own version.
 *
 * Only PyPI-sourced packages are reported. Poetry emits a `[package.source]`
 * sub-table for git / path / url / custom-index dependencies; a plain PyPI
 * dependency has none. So the presence of `[package.source]` marks a package
 * whose version OSV's PyPI ecosystem can't reliably answer for, and it's
 * skipped. (Consequence: a project whose *primary* source is a private mirror
 * — every package carries a `legacy` source table — yields nothing rather than
 * risk false positives against same-named public packages.)
 *
 * Anchoring: on the `version = "…"` line, so an in-place bump lands on an
 * added line for the dep-cve scanner (see the Cargo.lock parser for the full
 * rationale).
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

const NAME_RE = /^name = "(.*)"$/;
const VERSION_RE = /^version = "(.*)"$/;

class PoetryLockParser implements LockfileParser {
  readonly ecosystem = 'PyPI' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'poetry.lock';
  }

  parse(content: string): ParsedDependency[] {
    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    let name: string | undefined;
    let version: string | undefined;
    let versionLine: number | undefined;
    let hasSource = false;
    let inPackage = false; // anywhere inside the current [[package]] block
    let inTop = false; // in the block's direct key section (before sub-tables)

    const flush = (): void => {
      if (name !== undefined && version !== undefined && versionLine !== undefined && !hasSource) {
        out.push({ ecosystem: 'PyPI', name, version, line: versionLine });
      }
      name = version = undefined;
      versionLine = undefined;
      hasSource = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const t = (lines[i] ?? '').trim();

      if (t === '[[package]]') {
        flush();
        inPackage = true;
        inTop = true;
        continue;
      }
      if (t.startsWith('[')) {
        // A `[package.*]` header is a sub-table of the current package (it does
        // NOT end the block); any other table header ([metadata], [extras], …)
        // does.
        if (t === '[package.source]' && inPackage) hasSource = true;
        if (!t.startsWith('[package.')) {
          flush();
          inPackage = false;
        }
        inTop = false;
        continue;
      }
      if (!inTop) continue;

      const nameMatch = t.match(NAME_RE);
      if (nameMatch) {
        name = nameMatch[1];
        continue;
      }
      const versionMatch = t.match(VERSION_RE);
      if (versionMatch) {
        version = versionMatch[1];
        versionLine = i + 1;
      }
    }
    flush();

    return out;
  }
}

export const poetryLockParser: LockfileParser = new PoetryLockParser();
