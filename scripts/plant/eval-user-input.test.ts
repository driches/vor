import { describe, expect, it } from 'vitest';
import { evalUserInputTemplate } from './eval-user-input.js';
import type { PlantConfig } from '../eval/types.js';

describe('evalUserInputTemplate', () => {
  it('inserts an eval(userExpression) call at the requested line', () => {
    const source = ['line1', 'line2', 'line3'].join('\n');
    const { mutated, truth } = evalUserInputTemplate.apply(source, {
      type: 'eval-user-input',
      file: 'src/util/dynamic.ts',
      line: 2,
    });
    expect(mutated).toContain('eval(userExpression)');
    expect(truth).toEqual({
      file: 'src/util/dynamic.ts',
      line_range: [2, 2],
      bug_type: 'eval-user-input',
      severity: 'critical',
      category: ['security', 'bug'],
    });
  });

  it('honors a custom input_var name', () => {
    const { mutated } = evalUserInputTemplate.apply('a\nb\n', {
      type: 'eval-user-input',
      file: 'x.ts',
      line: 1,
      input_var: 'expr',
    });
    expect(mutated).toContain('eval(expr)');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      evalUserInputTemplate.apply('a\nb', {
        type: 'eval-user-input',
        file: 'x.ts',
        line: 99,
      }),
    ).toThrow(/line/i);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      evalUserInputTemplate.apply('a\nb', {
        type: 'eval-user-input',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
