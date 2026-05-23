import { describe, expect, it } from 'vitest';
import { sqlInjectionTemplate } from './sql-injection.js';

describe('sqlInjectionTemplate', () => {
  it('inserts a template-literal SQL query interpolating an unsanitized variable', () => {
    const source = 'export function query(userId: string) {\n  // body\n}\n';
    const { mutated, truth } = sqlInjectionTemplate.apply(source, {
      type: 'sql-injection',
      file: 'src/db.ts',
      line: 2,
      input_var: 'userId',
    });
    const lines = mutated.split('\n');
    expect(lines[1]).toContain('db.query');
    expect(lines[1]).toContain('${userId}');
    expect(lines[1]).toContain('SELECT');
    expect(truth.bug_type).toBe('sql-injection');
    expect(truth.severity).toBe('critical');
    expect(truth.category).toContain('security');
    expect(truth.line_range[0]).toBe(2);
  });

  it('defaults input_var to "input" when omitted', () => {
    const { mutated } = sqlInjectionTemplate.apply('a\nb', {
      type: 'sql-injection',
      file: 'x.ts',
      line: 1,
    });
    expect(mutated).toContain('${input}');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      sqlInjectionTemplate.apply('a\nb', {
        type: 'sql-injection',
        file: 'x.ts',
        line: 999,
      }),
    ).toThrow(/line/i);
  });
});
