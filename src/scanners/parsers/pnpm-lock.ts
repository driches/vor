/**
 * Parser for `pnpm-lock.yaml`. Supports both lockfile-version 5 (key format
 * `/<name>/<version>`) and lockfile-version 6+ (key format `/<name>@<version>`).
 *
 * Example (v6):
 *
 *   lockfileVersion: '6.0'
 *   packages:
 *     /lodash@4.17.21:
 *       resolution: { integrity: ... }
 *     /@scope/pkg@2.0.0:
 *       resolution: { integrity: ... }
 *
 * Example (v5):
 *
 *   lockfileVersion: 5.4
 *   packages:
 *     /lodash/4.17.21:
 *       resolution: { integrity: ... }
 *
 * Line anchoring: we re-scan the raw text for the key (with its leading
 * indentation and trailing colon) and use that line. The YAML library can't
 * give us a source map without dropping into the low-level AST, and the
 * textual scan is more than good enough for "click the version on PR".
 */
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

interface PnpmLockfileShape {
  packages?: Record<string, unknown>;
}

/**
 * Extract (name, version) from a packages-map key.
 *
 *   /lodash@4.17.21              → ('lodash', '4.17.21')
 *   /lodash/4.17.21              → ('lodash', '4.17.21')         (v5)
 *   /@scope/pkg@2.0.0            → ('@scope/pkg', '2.0.0')
 *   /@scope/pkg/2.0.0            → ('@scope/pkg', '2.0.0')       (v5)
 *   /lodash@4.17.21(peer@1.0.0)  → ('lodash', '4.17.21')         (peer-id suffix)
 */
function parsePnpmKey(rawKey: string): { name: string; version: string } | null {
  if (!rawKey.startsWith('/')) return null;
  let s = rawKey.slice(1);

  // Strip a v6 peer-dep ID suffix like `(react@18.0.0)`. Multiple peer ids may
  // chain together; take everything up to the first `(`.
  const parenIdx = s.indexOf('(');
  if (parenIdx >= 0) {
    s = s.slice(0, parenIdx);
  }

  // Initial parse: returns the spec's surface (name, version) where version
  // may still be an `npm:<real-package>@<ver>` alias spec — we unwrap below.
  const initial = parseSurface(s);
  if (initial == null) return null;

  // pnpm npm aliases: a key like `/lodash-old@npm:lodash@3.10.1` declares
  // `lodash-old` as a route to the real `lodash@3.10.1`. Advisories are
  // keyed to the REAL package, so we must emit the alias target's name —
  // not the alias label — for OSV lookups. Scoped alias targets work too:
  // `/my-react@npm:@scope/real@1.0.0` → name `@scope/real`, version `1.0.0`.
  if (initial.version.startsWith('npm:')) {
    return parsePnpmKey('/' + initial.version.slice('npm:'.length));
  }

  return initial;
}

/**
 * Split a pnpm key's body (post-`/`, peer suffix already stripped) into
 * `name` + `version` per the scoped/unscoped and v5/v6 separator rules.
 * Caller is responsible for unwrapping `npm:` aliases on the `version` field.
 */
function parseSurface(s: string): { name: string; version: string } | null {
  // Scoped packages start with `@scope/pkg<sep>version`. Find the separator
  // that comes AFTER the scope.
  if (s.startsWith('@')) {
    const slashIdx = s.indexOf('/');
    if (slashIdx < 0) return null;
    // Now look at what follows the scope/. The separator may be `@` (v6) or
    // `/` (v5).
    const rest = s.slice(slashIdx + 1);
    const atIdx = rest.indexOf('@');
    const slashAfter = rest.indexOf('/');
    let cut: number;
    if (atIdx >= 0 && (slashAfter < 0 || atIdx < slashAfter)) {
      cut = slashIdx + 1 + atIdx;
      const name = s.slice(0, cut);
      const version = s.slice(cut + 1);
      if (name.length === 0 || version.length === 0) return null;
      return { name, version };
    }
    if (slashAfter >= 0) {
      cut = slashIdx + 1 + slashAfter;
      const name = s.slice(0, cut);
      const version = s.slice(cut + 1);
      if (name.length === 0 || version.length === 0) return null;
      return { name, version };
    }
    return null;
  }

  // Unscoped: separator is `@` (v6) or `/` (v5).
  const atIdx = s.indexOf('@');
  const slashIdx = s.indexOf('/');
  let cut: number;
  if (atIdx >= 0 && (slashIdx < 0 || atIdx < slashIdx)) {
    cut = atIdx;
  } else if (slashIdx >= 0) {
    cut = slashIdx;
  } else {
    return null;
  }
  const name = s.slice(0, cut);
  const version = s.slice(cut + 1);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

function findKeyLine(lines: string[], rawKey: string): number {
  // Keys are emitted indented and followed by ':'. e.g. `  /lodash@4.17.21:`.
  const needle = `${rawKey}:`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimStart().startsWith(needle)) {
      return i + 1;
    }
  }
  return 1;
}

class PnpmLockParser implements LockfileParser {
  readonly ecosystem = 'npm' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'pnpm-lock.yaml';
  }

  parse(content: string): ParsedDependency[] {
    let doc: PnpmLockfileShape;
    try {
      doc = parseYaml(content) as PnpmLockfileShape;
    } catch {
      return [];
    }
    if (!doc || typeof doc !== 'object' || !doc.packages || typeof doc.packages !== 'object') {
      return [];
    }

    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];
    const seen = new Set<string>();

    for (const rawKey of Object.keys(doc.packages)) {
      const parsed = parsePnpmKey(rawKey);
      if (parsed == null) continue;
      // Dedup: peer-dep variations of the same dep can produce multiple keys
      // for the same (name, version). One entry per (name, version) is enough
      // for OSV.
      const dedupKey = `${parsed.name}@${parsed.version}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.push({
        ecosystem: 'npm',
        name: parsed.name,
        version: parsed.version,
        line: findKeyLine(lines, rawKey),
      });
    }

    return out;
  }
}

export const pnpmLockParser: LockfileParser = new PnpmLockParser();
