/**
 * Plant an AWS access key as a top-level `const` declaration at the requested
 * line. Inserts (does not replace) so subsequent line numbers shift by one.
 *
 * Default value is AWS's canonical EXAMPLE marker so GitHub push-protection
 * doesn't flag the planted fixture as a real key.
 */
import type { PlantTemplate } from './types.js';

const DEFAULT_VALUE = 'AKIAIOSFODNN7EXAMPLE';

export const awsAccessKeyTemplate: PlantTemplate = {
  type: 'secret:aws-access-key',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      // Without a non-empty file, the resulting TruthEntry.file would be ''
      // and scoreRun's `finding.file_path === truth.file` would never match
      // → guaranteed FN for this plant with no diagnostic. Fail loud at
      // plant time. See PR #10 dogfood comment 3295156535.
      throw new Error(`aws-access-key: missing or empty 'file' param in plants.yml entry`);
    }
    const value = typeof config.value === 'string' ? config.value : DEFAULT_VALUE;
    if (!/^AKIA[0-9A-Z]{16}$/.test(value)) {
      throw new Error(
        `aws-access-key value ${JSON.stringify(value)} doesn't look like a real AWS access key id (AKIA + 16 [0-9A-Z])`,
      );
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `aws-access-key: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const insertion = `const PLANTED_AWS_KEY = "${value}";`;
    // Insert at (line-1) → the new content sits AT `line`.
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    const mutated = [...before, insertion, ...after].join('\n');
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'secret:aws-access-key',
        severity: 'critical',
        category: ['vulnerability', 'security'] as const,
      },
    };
  },
};
