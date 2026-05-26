/**
 * Plant a GitHub Personal Access Token (classic) as a top-level `const`
 * declaration. Inserts (does not replace) so subsequent line numbers shift
 * by one.
 *
 * Default value is an obvious placeholder — 36 a's after the `ghp_` prefix.
 * It matches the secrets-scanner regex (`ghp_[A-Za-z0-9]{36}`) but isn't a
 * real issued token, so GitHub's push-protection should leave it alone if the
 * planted file is ever committed. The plant only writes to `after/` (a
 * tmpdir at test time), so in practice the value never reaches a committed
 * file anyway.
 */
import type { PlantTemplate } from './types.js';

const DEFAULT_VALUE = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const githubPatTemplate: PlantTemplate = {
  type: 'secret:github-pat',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`secret:github-pat: missing or empty 'file' param in plants.yml entry`);
    }
    const value = typeof config.value === 'string' ? config.value : DEFAULT_VALUE;
    // Regex matches GitHub's classic-PAT format. The newer fine-grained PATs
    // use a `github_pat_` prefix and a different length; if we ever add a
    // template for those, it's a separate type to keep the regex unambiguous.
    if (!/^ghp_[A-Za-z0-9]{36}$/.test(value)) {
      throw new Error(
        `secret:github-pat: value ${JSON.stringify(value)} doesn't match the GitHub classic-PAT format (ghp_ + 36 [A-Za-z0-9])`,
      );
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `secret:github-pat: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const insertion = `const PLANTED_GH_PAT = "${value}";`;
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    return {
      mutated: [...before, insertion, ...after].join('\n'),
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'secret:github-pat',
        severity: 'critical',
        category: ['vulnerability', 'security'] as const,
      },
    };
  },
};
