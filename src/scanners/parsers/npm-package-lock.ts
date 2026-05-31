/**
 * Parser for `package-lock.json` (npm v7+, lockfile versions 2 and 3).
 *
 * Format reminder — the file has a `packages` map keyed by install path:
 *
 *   {
 *     "packages": {
 *       "":                            { ...root, includes the project's own
 *                                          version+name+deps, no `version` for
 *                                          our purposes — skip },
 *       "node_modules/foo":            { "version": "1.2.3", ... },
 *       "node_modules/foo/node_modules/bar": { "version": "0.5.1", ... }
 *     }
 *   }
 *
 * Line-anchoring strategy: we re-scan the raw text for `"node_modules/<name>"`
 * and grab the next `"version":` line within a small window. This is "best
 * effort"; on weird formatting we fall back to line 1 (with a logged warn at
 * the caller). The trade-off is documented in the Task 4 spec.
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

const LOOKAHEAD_LINES = 30;

interface PackagesShape {
  packages?: Record<string, { version?: string } | undefined>;
}

/**
 * Extract the package name from a `packages` map key. Keys look like:
 *   "node_modules/foo"
 *   "node_modules/foo/node_modules/@scope/bar"
 * The package name is the last `node_modules/...` segment. Scoped packages
 * (`@scope/name`) are kept intact.
 */
function packageNameFromKey(key: string): string | null {
  // Find the LAST occurrence of "node_modules/". Everything after it is the
  // installed package's name (potentially scoped).
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx < 0) return null;
  const name = key.slice(idx + marker.length);
  if (name.length === 0) return null;
  return name;
}

/**
 * Find the 1-indexed line of the `"version":` declaration belonging to the
 * given install-path key. Scan strategy:
 *   1. Locate the JSON-quoted key string in the raw file.
 *   2. From that line, look forward up to LOOKAHEAD_LINES for `"version":`.
 *   3. Fall back to line 1 if we can't locate either.
 *
 * This is intentionally textual rather than JSON-AST-based — package-lock
 * files routinely run into tens of thousands of lines and the cost of a
 * full source-mapped parse is not worth it for v1.
 */
function findVersionLine(lines: string[], installKey: string): number {
  // Anchor the quoted key at a word boundary: the character after the closing
  // quote must be a JSON key terminator (`:`, whitespace, end-of-line). This
  // prevents `"node_modules/foo"` from substring-matching inside a longer key
  // like `"node_modules/react-router/node_modules/foo"`, which would silently
  // anchor the CVE comment on the wrong line and lose the finding entirely.
  const quoted = `"${installKey}"`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const pos = line.indexOf(quoted);
    if (pos < 0) continue;
    const charAfter = line[pos + quoted.length];
    if (charAfter !== undefined && charAfter !== ':' && charAfter !== ' ' && charAfter !== '\t') {
      continue;
    }
    const end = Math.min(lines.length, i + 1 + LOOKAHEAD_LINES);
    for (let j = i; j < end; j++) {
      if (/"version"\s*:/.test(lines[j]!)) {
        return j + 1;
      }
    }
    return i + 1;
  }
  return 1;
}

class NpmPackageLockParser implements LockfileParser {
  readonly ecosystem = 'npm' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'package-lock.json';
  }

  parse(content: string): ParsedDependency[] {
    let parsed: PackagesShape;
    try {
      parsed = JSON.parse(content) as PackagesShape;
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.packages) return [];

    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    for (const [key, value] of Object.entries(parsed.packages)) {
      // Skip the root entry (key "") — that's the project itself, not a dep.
      if (key === '') continue;
      if (value == null || typeof value.version !== 'string') continue;

      const name = packageNameFromKey(key);
      if (name == null) continue;

      const line = findVersionLine(lines, key);
      out.push({
        ecosystem: 'npm',
        name,
        version: value.version,
        line,
      });
    }

    return out;
  }
}

export const npmPackageLockParser: LockfileParser = new NpmPackageLockParser();
