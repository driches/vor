/**
 * Plant a vulnerable npm package in a package-lock.json. We JSON-parse,
 * inject a `packages["node_modules/<name>"]` entry with the given version,
 * then re-serialize with 2-space indent. The truth `line_range` is the
 * line of the new entry's `"version":` declaration (matches the
 * dependency-cve scanner's anchor strategy).
 */
import type { PlantTemplate } from './types.js';

interface PackageLockShape {
  packages?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export const vulnDepNpmTemplate: PlantTemplate = {
  type: 'vuln-dep:npm',
  apply(source, config) {
    if (config.file !== 'package-lock.json' && !String(config.file).endsWith('/package-lock.json')) {
      throw new Error(
        `vuln-dep:npm only applies to package-lock.json, got ${String(config.file)}`,
      );
    }
    const pkg = typeof config.package === 'string' ? config.package : '';
    const ver = typeof config.version === 'string' ? config.version : '';
    if (!pkg || !ver) {
      throw new Error(
        `vuln-dep:npm requires both 'package' and 'version' params`,
      );
    }
    let parsed: PackageLockShape;
    try {
      parsed = JSON.parse(source) as PackageLockShape;
    } catch (err) {
      throw new Error(
        `vuln-dep:npm: lockfile is invalid JSON: ${(err as Error).message}`,
      );
    }
    parsed.packages = parsed.packages ?? {};
    // Refuse no-op plants: if the lockfile already pins exactly this
    // package@version, the mutation produces an identical `after/` file.
    // synthesizeDiff then drops the file (before === after), the
    // dependency-cve scanner never sees an "added" line, and the truth
    // entry scores as a guaranteed FN — silently biasing eval metrics.
    // Fail loud at plant time so the operator can pick a version that
    // ISN'T already in the lockfile. See PR #10 Codex P2 3295066582.
    const existingEntry = parsed.packages[`node_modules/${pkg}`];
    if (
      existingEntry != null &&
      typeof existingEntry === 'object' &&
      (existingEntry as { version?: unknown }).version === ver
    ) {
      throw new Error(
        `vuln-dep:npm: ${pkg}@${ver} is already pinned in the lockfile — ` +
          `plant would be a no-op and the truth entry would score as FN. ` +
          `Pick a different version or remove the existing entry from before/.`,
      );
    }
    // Preserve any pre-existing fields (resolved, integrity, requires, etc.)
    // on an upgrade-pin so the mutated lockfile stays realistic. A real
    // package-lock.json carries `resolved` URLs and `integrity` SHA hashes;
    // wholesale replacement strips those, and downstream tools (the
    // dependency-cve scanner here is forgiving, but production npm/yarn
    // tooling typically requires them) may skip or error on the entry.
    // See PR #10 dogfood IMPORTANT 3295239963.
    parsed.packages[`node_modules/${pkg}`] = {
      ...(existingEntry != null && typeof existingEntry === 'object' ? existingEntry : {}),
      version: ver,
    };
    const mutated = JSON.stringify(parsed, null, 2) + '\n';

    // Locate the new "version": line. Re-serialization is deterministic
    // because of the 2-space indent we just used; find the FIRST occurrence
    // of the package's entry key and then the "version" line that follows.
    const lines = mutated.split('\n');
    const keyMatch = `"node_modules/${pkg}":`;
    let entryLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(keyMatch)) {
        entryLine = i + 1; // 1-indexed
        break;
      }
    }
    if (entryLine < 0) {
      throw new Error(
        `vuln-dep:npm: failed to locate planted entry for ${pkg}`,
      );
    }
    let versionLine = -1;
    for (let i = entryLine; i < lines.length; i++) {
      if (lines[i]!.includes('"version":')) {
        versionLine = i + 1;
        break;
      }
    }
    // Refuse to silently fall back to entryLine — a missing "version": line
    // means the JSON serializer produced a shape we don't recognise, and
    // anchoring the truth at the package-key line would make the CVE truth
    // score as FN despite a correct scanner hit (the scanner anchors at
    // "version":). See PR #10 comment 3295026564.
    if (versionLine < 0) {
      throw new Error(
        `vuln-dep:npm: planted entry for ${pkg} has no "version": line — ` +
          `cannot anchor truth, refusing to silently mis-anchor at the key line`,
      );
    }
    return {
      mutated,
      truth: {
        file: String(config.file),
        line_range: [versionLine, versionLine] as const,
        bug_type: `vuln-dep:npm:${pkg}@${ver}`,
        severity: 'critical',
        category: ['vulnerability'] as const,
      },
    };
  },
};
