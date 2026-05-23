/**
 * Plant a template-literal SQL query with an unsanitized interpolation. Tests
 * the AI's recognition of string-concatenation injection — the secrets and
 * dependency-cve scanners are inert here.
 */
import type { PlantTemplate } from './types.js';

export const sqlInjectionTemplate: PlantTemplate = {
  type: 'sql-injection',
  apply(source, config) {
    const line = typeof config.line === 'number' ? config.line : NaN;
    const lines = source.split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length + 1) {
      throw new Error(
        `sql-injection: line ${line} is outside the file (1..${lines.length + 1})`,
      );
    }
    const inputVar =
      typeof config.input_var === 'string' ? config.input_var : 'input';
    const insertion =
      `  const result = await db.query(\`SELECT * FROM users WHERE id = \${${inputVar}}\`);`;
    const before = lines.slice(0, line - 1);
    const after = lines.slice(line - 1);
    return {
      mutated: [...before, insertion, ...after].join('\n'),
      truth: {
        file: typeof config.file === 'string' ? config.file : '',
        line_range: [line, line] as const,
        bug_type: 'sql-injection',
        severity: 'critical',
        category: ['security', 'bug'] as const,
      },
    };
  },
};
