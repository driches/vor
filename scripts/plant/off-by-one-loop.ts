/**
 * Plant a classic off-by-one loop: `for (let i = 0; i <= arr.length; i++)`.
 * On the final iteration `arr[arr.length]` is `undefined`, so the sum/use
 * downstream picks up a garbage value (or throws on a NaN-add, or quietly
 * corrupts results — depends on the surrounding code).
 *
 * Replace-anchored: the case author's `before/` snippet must include a line
 * that trims to `// PLANT_ANCHOR: off-by-one-loop`. The template swaps that
 * line for the buggy loop, preserving the surrounding context so the agent
 * sees a coherent function rather than a free-floating loop dropped into
 * unrelated code.
 */
import type { PlantTemplate } from './types.js';
import { replaceAnchor } from './anchor.js';

const MARKER = '// PLANT_ANCHOR: off-by-one-loop';
const REPLACEMENT = 'for (let i = 0; i <= arr.length; i++) { sum += arr[i]; }';

export const offByOneLoopTemplate: PlantTemplate = {
  type: 'off-by-one-loop',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`off-by-one-loop: missing or empty 'file' param in plants.yml entry`);
    }
    const { mutated, line } = replaceAnchor(source, MARKER, REPLACEMENT, 'off-by-one-loop');
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'off-by-one-loop',
        severity: 'important',
        category: ['bug', 'error-handling', 'data-loss'] as const,
      },
    };
  },
};
