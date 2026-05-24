/**
 * Per-ecosystem package-name canonicalization rules.
 *
 * Different package registries treat names with different equivalence rules.
 * Lockfiles (and human-written ignore entries) may use any of those forms,
 * but OSV/registry advisories use only the canonical one. Two name strings
 * for the same package will compare equal here.
 *
 *   - **npm**: case-insensitive only. The registry normalizes by lowercasing.
 *   - **PyPI**: PEP 503 — lowercase + `_`/`.`/`-` are equivalent (any run of
 *     them collapses to a single `-`). So `zope.interface`, `zope_interface`,
 *     and `Zope-Interface` are all the same project.
 *   - **other ecosystems**: returned verbatim. Add cases here as we add
 *     parsers for new ecosystems.
 *
 * Callers that compare two names from possibly-different sources (lockfile
 * vs OSV affected list; ignore-file entry vs scanner finding; etc.) MUST
 * route through this helper rather than rolling their own lowercase calls.
 */
export function canonicalizePackageName(name: string, ecosystem: string): string {
  switch (ecosystem) {
    case 'npm':
      return name.toLowerCase();
    case 'PyPI':
      // PEP 503: collapse any run of `_`, `.`, or `-` to a single `-`, then
      // lowercase. The combined form prevents `zope__interface` ≠
      // `zope-interface` from slipping through.
      return name.toLowerCase().replace(/[-_.]+/g, '-');
    default:
      return name;
  }
}
