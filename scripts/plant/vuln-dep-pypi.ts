/**
 * Plant a vulnerable Python (PyPI) package pin in a `requirements.txt`. We
 * parse the file line-by-line, look for an existing `<package>==<ver>` (or
 * `<package>>=...`, etc.) line for the named package, and either:
 *   - update the line in place if the package is already present
 *   - append a new `package==version` line at the end if it isn't
 *
 * The truth `line_range` points at the (1-based) line of the pinned-version
 * requirement, mirroring how the npm template anchors at the "version": line.
 *
 * Refuses no-op plants: if the file already pins exactly `package==version`,
 * the mutation produces an identical `after/` file, synthesizeDiff drops it,
 * and the truth scores as a guaranteed FN. Fail loud instead.
 */
import type { PlantTemplate } from './types.js';

// Operator alternation order matters: `[<>=!~]=?` is greedy and would
// consume `==` from a `===` operator before the `===` branch ever ran,
// so `requests===2.5.0` would parse with operator=`==` and version=`=2.5.0`.
// Behavior was incidentally correct (version didn't match the requested
// `2.5.0` → no-op skipped) but the regex intent was wrong. List `===`
// first so it's tried before the greedy branch.
const REQUIREMENT_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(===|[<>=!~]=?)\s*([^\s#]+)/;

export const vulnDepPypiTemplate: PlantTemplate = {
  type: 'vuln-dep:pypi',
  apply(source, config) {
    const fileStr = String(config.file ?? '');
    if (fileStr !== 'requirements.txt' && !fileStr.endsWith('/requirements.txt')) {
      throw new Error(
        `vuln-dep:pypi only applies to requirements.txt, got ${fileStr}`,
      );
    }
    const pkg = typeof config.package === 'string' ? config.package : '';
    const ver = typeof config.version === 'string' ? config.version : '';
    if (!pkg || !ver) {
      throw new Error(`vuln-dep:pypi requires both 'package' and 'version' params`);
    }
    const lines = source.split('\n');
    // Strip the trailing-newline-induced empty line from .split('\n') so we
    // don't accidentally count the file's terminating newline as a real line.
    const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    const bodyLines = trailingEmpty ? lines.slice(0, -1) : lines;
    let matchedIdx = -1;
    let matchedOperator: string | undefined;
    let matchedVersion: string | undefined;
    for (let i = 0; i < bodyLines.length; i++) {
      const m = bodyLines[i]!.match(REQUIREMENT_LINE);
      // pip is case-insensitive AND treats `-` / `_` / `.` as equivalent in
      // distribution names per PEP 503. Normalize both sides so the planter
      // matches `Django` against `django`, `oauth-lib` against `oauth_lib`,
      // etc., the same way pip's resolver would.
      if (m && normalizeName(m[1]!) === normalizeName(pkg)) {
        matchedIdx = i;
        matchedOperator = m[2];
        matchedVersion = m[3];
        break;
      }
    }
    const newRequirement = `${pkg}==${ver}`;
    if (matchedIdx >= 0) {
      // No-op detection: a pre-existing line that pins the SAME package at
      // the SAME version (via the `==` operator) means rewriting it to
      // `${pkg}==${ver}` produces a semantically identical lockfile state
      // — the OSV scanner already saw this vulnerable pin in before/, so
      // the truth entry would score as a TP credited to the planted bug
      // when the finding was actually pre-existing. Compare the parsed
      // (name, version) — not the raw line text — so casing
      // (`Requests==2.5.0`), name normalization (`oauth-lib` vs
      // `oauth_lib`), whitespace (`requests == 2.5.0`), and PEP 440
      // release-segment equivalence (`2.5` == `2.5.0`) all canonicalize
      // to the same no-op. Other operators (`===`, `>=`, `~=`) are real
      // mutations because they change the resolved pin.
      // See PR #19 Codex P2 3299774234 + 3299840874.
      if (
        matchedOperator === '==' &&
        canonicalizeVersion(matchedVersion!) === canonicalizeVersion(ver)
      ) {
        throw new Error(
          `vuln-dep:pypi: ${pkg}==${ver} is already pinned in requirements.txt — ` +
            `plant would be a no-op and the truth entry would score as FN. ` +
            `Pick a different version or remove the existing entry from before/.`,
        );
      }
      const updated = [...bodyLines];
      updated[matchedIdx] = newRequirement;
      const mutated = [...updated, ...(trailingEmpty ? [''] : [])].join('\n');
      return {
        mutated,
        truth: {
          file: fileStr,
          line_range: [matchedIdx + 1, matchedIdx + 1] as const,
          bug_type: `vuln-dep:pypi:${pkg}@${ver}`,
          severity: 'critical',
          category: ['vulnerability'] as const,
        },
      };
    }
    // Append a new requirement line at the end of the body, preserving the
    // file's trailing newline if it had one.
    const updated = [...bodyLines, newRequirement];
    const mutated = [...updated, ...(trailingEmpty ? [''] : [])].join('\n');
    return {
      mutated,
      truth: {
        file: fileStr,
        line_range: [updated.length, updated.length] as const,
        bug_type: `vuln-dep:pypi:${pkg}@${ver}`,
        severity: 'critical',
        category: ['vulnerability'] as const,
      },
    };
  },
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Canonicalize a PEP 440 version for `==` equivalence comparison.
 *
 * PEP 440 zero-pads release segments under `==` matching, so `2.5`, `2.5.0`,
 * and `2.5.0.0` all pin the same release. The no-op guard must treat these
 * as equivalent, or a fixture pre-pinned at `requests==2.5` would not be
 * caught when a plant requests `requests==2.5.0` — the template would
 * rewrite a semantically identical pin and credit the OSV finding to the
 * "planted" bug, inflating TP. See PR #19 Codex P2 3299840874.
 *
 * Scope: handles the common case (trailing `.0` segments). Does NOT
 * canonicalize:
 *   - Pre-release tag forms (`a1` vs `alpha1` vs `A1`)
 *   - Post/dev/local segments
 *   - Epoch prefixes (`1!2.5`)
 * These are rare in eval fixtures; treating them as distinct strings is a
 * safer failure mode than under-canonicalizing.
 */
function canonicalizeVersion(v: string): string {
  // Match a leading dot-separated numeric release prefix and preserve any
  // non-numeric tail (pre/post/dev/local labels) unchanged.
  const m = v.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!m) return v;
  const segments = m[1]!.split('.').map((s) => parseInt(s, 10));
  // Strip trailing zeros from the release sequence, but keep at least one
  // segment so `0.0` and `0.0.0` canonicalize to `0` (not the empty string).
  while (segments.length > 1 && segments[segments.length - 1] === 0) {
    segments.pop();
  }
  return segments.join('.') + m[2]!;
}
