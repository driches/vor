/**
 * Plant a missing-null-check: `const name = result.user.name;` where
 * `result.user` is the (possibly-null) return from an upstream fetch. On
 * the cache-miss / not-found path this throws "Cannot read properties of
 * null (reading 'name')" at runtime.
 *
 * Replace-anchored: the case author's `before/` snippet must include a line
 * that trims to `// PLANT_ANCHOR: missing-null-check`. The template swaps
 * that line for the dereferencing line, preserving the surrounding fetch
 * context so the agent can reason about whether `result.user` may be null.
 */
import type { PlantTemplate } from './types.js';
import { replaceAnchor } from './anchor.js';

const MARKER = '// PLANT_ANCHOR: missing-null-check';
const REPLACEMENT = 'const name = result.user.name;';

export const missingNullCheckTemplate: PlantTemplate = {
  type: 'missing-null-check',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`missing-null-check: missing or empty 'file' param in plants.yml entry`);
    }
    const { mutated, line } = replaceAnchor(source, MARKER, REPLACEMENT, 'missing-null-check');
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'missing-null-check',
        severity: 'important',
        category: ['bug', 'error-handling'] as const,
      },
    };
  },
};
