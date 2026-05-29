/**
 * Plant an unsanitized path-traversal vulnerability — a `fs.readFile` whose
 * path interpolates an arbitrary `${input}` variable into a join() call,
 * letting `../../etc/passwd`-style inputs escape the intended base directory.
 *
 * Inserts a single statement; subsequent line numbers shift by one. The
 * surrounding `before/` snippet must already import `fs` and `path` (or
 * have them in scope) — that's the case author's responsibility. The agent
 * is judged on whether it flags the traversal, not the (synthetic) import
 * graph.
 */
import type { PlantTemplate } from './types.js';

export const pathTraversalTemplate: PlantTemplate = {
  type: 'path-traversal',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`path-traversal: missing or empty 'file' param in plants.yml entry`);
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(`path-traversal: line ${line} is outside the file (1..${lines.length + 1})`);
    }
    const inputVar = typeof config.input_var === 'string' ? config.input_var : 'filename';
    const baseVar = typeof config.base_var === 'string' ? config.base_var : 'baseDir';
    const insertion = `  const fileData = await fs.readFile(path.join(${baseVar}, ${inputVar}), 'utf-8');`;
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    return {
      mutated: [...before, insertion, ...after].join('\n'),
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'path-traversal',
        severity: 'critical',
        category: ['security', 'bug'] as const,
      },
    };
  },
};
