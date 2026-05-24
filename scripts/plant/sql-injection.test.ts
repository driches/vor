import { describe, expect, it } from 'vitest';
import { sqlInjectionTemplate } from './sql-injection.js';
import type { PlantConfig } from '../eval/types.js';

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

  it('throws when `file` param is missing or empty (regression: silent FN)', () => {
    // Regression for PR #10 dogfood MINOR 3295156535. Same root cause as in
    // aws-access-key.ts: an empty truth.file makes scoreRun never match,
    // silently producing FN with no diagnostic. Cast to bypass the type-level
    // requirement on `file` — testing the runtime guard against malformed yml.
    expect(() =>
      sqlInjectionTemplate.apply('a\nb', {
        type: 'sql-injection',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
    expect(() =>
      sqlInjectionTemplate.apply('a\nb', {
        type: 'sql-injection',
        file: '',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
