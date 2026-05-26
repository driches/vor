/**
 * Plant a sync-in-async loop: `items.forEach(async (item) => { await … })`.
 * `Array.prototype.forEach` does not await its callback, so the outer
 * function returns before any of the inner awaits resolve. Errors get
 * swallowed, ordering is non-deterministic, and downstream code observes
 * a half-processed state.
 *
 * Replace-anchored: the case author's `before/` snippet must include a line
 * that trims to `// PLANT_ANCHOR: sync-in-async-loop`. The template swaps
 * that line for the buggy forEach, preserving the surrounding async function
 * so the agent can see that the result is being awaited elsewhere.
 */
import type { PlantTemplate } from './types.js';
import { replaceAnchor } from './anchor.js';

const MARKER = '// PLANT_ANCHOR: sync-in-async-loop';
const REPLACEMENT = 'items.forEach(async (item) => { await processOne(item); });';

export const syncInAsyncLoopTemplate: PlantTemplate = {
  type: 'sync-in-async-loop',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`sync-in-async-loop: missing or empty 'file' param in plants.yml entry`);
    }
    const { mutated, line } = replaceAnchor(source, MARKER, REPLACEMENT, 'sync-in-async-loop');
    return {
      mutated,
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'sync-in-async-loop',
        severity: 'important',
        category: ['performance', 'bug', 'error-handling'] as const,
      },
    };
  },
};
