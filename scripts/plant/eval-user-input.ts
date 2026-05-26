/**
 * Plant an unsanitized `eval(userInput)` call — the canonical "remote code
 * execution via dynamic-evaluation primitive" pattern. Inserts a single
 * statement; subsequent line numbers shift by one.
 *
 * The agent is expected to flag this as a security/bug regardless of context:
 * `eval` on untrusted input is almost never the right call. The smoke-test
 * sampler (commit 4593c6e) uses the same pattern.
 */
import type { PlantTemplate } from './types.js';

export const evalUserInputTemplate: PlantTemplate = {
  type: 'eval-user-input',
  apply(source, config) {
    if (typeof config.file !== 'string' || config.file.length === 0) {
      throw new Error(`eval-user-input: missing or empty 'file' param in plants.yml entry`);
    }
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `eval-user-input: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const inputVar =
      typeof config.input_var === 'string' ? config.input_var : 'userExpression';
    const insertion = `  const result = eval(${inputVar});`;
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    return {
      mutated: [...before, insertion, ...after].join('\n'),
      truth: {
        file: config.file,
        line_range: [line, line] as const,
        bug_type: 'eval-user-input',
        severity: 'critical',
        category: ['security', 'bug'] as const,
      },
    };
  },
};
