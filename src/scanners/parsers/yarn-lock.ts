/**
 * Parser for `yarn.lock` (Yarn 1.x classic format).
 *
 * Each record looks like:
 *
 *   foo@^1.2.3:
 *     version "1.2.4"
 *     resolved "..."
 *
 * or with multiple specifiers on one quoted header:
 *
 *   "foo@^1.2.3", "foo@~1.2.0":
 *     version "1.2.4"
 *
 * Scoped packages keep the leading `@` (e.g. `"@scope/pkg@^2.0.0":`).
 *
 * We scan the file by walking entry headers (lines starting at column 0
 * ending with `:`) and grabbing the next `  version "..."` line. Yarn 2+
 * (Berry) emits YAML, which this parser does NOT support — `matches()`
 * still returns true for the file but `parse()` returns [] on YAML input
 * (no `name@spec:` headers will be found).
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

/**
 * Capture the package name from a single specifier `name@range` segment.
 * Examples:
 *   `foo@^1.2.3`           → 'foo'
 *   `"@scope/pkg@^2.0.0"`  → '@scope/pkg'
 *   `"@scope/pkg@npm:^2.0.0"` → '@scope/pkg'
 */
function extractName(specifier: string): string | null {
  let s = specifier.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  // For scoped packages, the leading '@' is the package's own scope and not
  // the version delimiter. We need to find the SECOND '@' for scoped names.
  let atIdx: number;
  if (s.startsWith('@')) {
    atIdx = s.indexOf('@', 1);
  } else {
    atIdx = s.indexOf('@');
  }
  if (atIdx <= 0) return null;
  return s.slice(0, atIdx);
}

class YarnLockParser implements LockfileParser {
  readonly ecosystem = 'npm' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'yarn.lock';
  }

  parse(content: string): ParsedDependency[] {
    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      // A record header starts at column 0, is non-blank, isn't a comment,
      // and ends with ':'. Subsequent body lines are indented.
      const isHeader =
        line.length > 0 &&
        !line.startsWith('#') &&
        !line.startsWith(' ') &&
        !line.startsWith('\t') &&
        line.endsWith(':');

      if (!isHeader) {
        i++;
        continue;
      }

      const header = line.slice(0, -1); // strip trailing ':'
      // First specifier is enough to learn the package name. Splitting on
      // commas-not-inside-quotes is fine: yarn doesn't use commas inside
      // version ranges.
      const firstSpec = header.split(',')[0]?.trim() ?? '';
      const name = extractName(firstSpec);

      // Scan forward for the `version "..."` body line.
      let version: string | null = null;
      let versionLine = i + 1;
      let j = i + 1;
      while (j < lines.length) {
        const body = lines[j]!;
        // End of the record: a blank line or another header (column-0
        // non-blank).
        if (body.length === 0) break;
        if (
          !body.startsWith(' ') &&
          !body.startsWith('\t') &&
          !body.startsWith('#') &&
          body.endsWith(':')
        ) {
          break;
        }
        const m = body.match(/^\s+version\s+"([^"]+)"/);
        if (m) {
          version = m[1]!;
          versionLine = j + 1;
          break;
        }
        j++;
      }

      if (name != null && version != null) {
        out.push({
          ecosystem: 'npm',
          name,
          version,
          // Anchor on the `version "..."` line; matches the user's mental
          // model of "the line that says 1.2.4 is the line that's flagged".
          line: versionLine,
        });
      }

      // Skip ahead past the record body so we don't re-enter it as a header.
      i = j + 1;
    }

    return out;
  }
}

export const yarnLockParser: LockfileParser = new YarnLockParser();
