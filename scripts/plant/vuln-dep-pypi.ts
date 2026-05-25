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

const REQUIREMENT_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~]=?|===)\s*([^\s#]+)/;

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
    for (let i = 0; i < bodyLines.length; i++) {
      const m = bodyLines[i]!.match(REQUIREMENT_LINE);
      // pip is case-insensitive AND treats `-` / `_` / `.` as equivalent in
      // distribution names per PEP 503. Normalize both sides so the planter
      // matches `Django` against `django`, `oauth-lib` against `oauth_lib`,
      // etc., the same way pip's resolver would.
      if (m && normalizeName(m[1]!) === normalizeName(pkg)) {
        matchedIdx = i;
        break;
      }
    }
    const newRequirement = `${pkg}==${ver}`;
    if (matchedIdx >= 0) {
      const existing = bodyLines[matchedIdx]!;
      if (existing.trim() === newRequirement) {
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
