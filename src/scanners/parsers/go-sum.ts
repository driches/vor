/**
 * Parser for `go.sum`.
 *
 * Each line is `<module-path> <version>[/go.mod] <hash>`, e.g.
 *
 *   github.com/gin-gonic/gin v1.6.3 h1:ahKqKTFpO5KTPHxWZjEdPScmYaGtLo8Y4DMHoEsnp14=
 *   github.com/gin-gonic/gin v1.6.3/go.mod h1:75u5sXoLsGZoRN5Sgbi1eraJ4GU3++wFwWzhwvtwp4M=
 *
 * Only the code line (no `/go.mod` suffix) is reported. The `/go.mod` line
 * duplicates the module entry, and — since Go 1.17 module-graph pruning — a
 * module can appear with ONLY a `/go.mod` line when its code is never built
 * into the binary. Reporting those would flag CVEs in modules the project
 * doesn't actually compile.
 *
 * Version normalization: go.sum versions carry Go's mandatory `v` prefix
 * (`v1.6.3`); OSV's Go ecosystem publishes versions without it (`1.6.3`), so
 * the prefix is stripped. Pseudo-versions
 * (`v0.0.0-20190603091049-60506f45cf65`) and `+incompatible` suffixes pass
 * through otherwise unchanged — both are valid semver once the `v` is gone,
 * which the dep-cve scanner's range matching relies on.
 *
 * `go.mod` itself is NOT parsed: it only lists direct requirements (and can
 * omit versions selected by MVS), while go.sum enumerates the full module
 * graph that actually ships.
 */
import path from 'node:path';
import type { ChangedFile } from '../../types.js';
import type { LockfileParser, ParsedDependency } from './types.js';

// `<module> v<version>[/go.mod] <hash>` — the hash column is required so a
// bare module/version mention in some other file named go.sum doesn't parse.
// Version chars: semver + pseudo-version timestamp/sha + `+incompatible`.
// The `/go.mod` suffix is captured (group 3) so `parse` can skip those lines
// deliberately rather than by regex accident.
const GO_SUM_LINE_RE = /^(\S+)\s+v([0-9][A-Za-z0-9.+-]*)(\/go\.mod)?\s+h1:\S+$/;

class GoSumParser implements LockfileParser {
  readonly ecosystem = 'Go' as const;

  matches(file: ChangedFile): boolean {
    return path.basename(file.path) === 'go.sum';
  }

  parse(content: string): ParsedDependency[] {
    const lines = content.split(/\r?\n/);
    const out: ParsedDependency[] = [];

    for (let i = 0; i < lines.length; i++) {
      const m = (lines[i] ?? '').trim().match(GO_SUM_LINE_RE);
      if (m == null) continue;
      // `/go.mod` entries — skip per the module-pruning rationale above.
      if (m[3] != null) continue;

      out.push({
        ecosystem: 'Go',
        name: m[1]!,
        version: m[2]!,
        line: i + 1,
      });
    }

    return out;
  }
}

export const goSumParser: LockfileParser = new GoSumParser();
