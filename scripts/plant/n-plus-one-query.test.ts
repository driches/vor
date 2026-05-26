import { describe, expect, it } from 'vitest';
import { nPlusOneQueryTemplate } from './n-plus-one-query.js';
import type { PlantConfig } from '../eval/types.js';

describe('nPlusOneQueryTemplate', () => {
  it('inserts a for-of loop with an await db.query inside', () => {
    const source = ['line1', 'line2', 'line3'].join('\n');
    const { mutated, truth } = nPlusOneQueryTemplate.apply(source, {
      type: 'n-plus-one-query',
      file: 'src/services/user.ts',
      line: 2,
    });
    const lines = mutated.split('\n');
    expect(lines[1]).toContain('for (const item of items)');
    expect(lines[2]).toContain('await db.query');
    expect(lines[3]).toContain('item.row = row;');
    expect(lines[4]).toContain('}');
    expect(truth).toEqual({
      file: 'src/services/user.ts',
      line_range: [3, 3],
      bug_type: 'n-plus-one-query',
      severity: 'important',
      category: ['performance'],
    });
  });

  it('honors a custom items_var name', () => {
    const { mutated } = nPlusOneQueryTemplate.apply('a\nb\n', {
      type: 'n-plus-one-query',
      file: 'x.ts',
      line: 1,
      items_var: 'users',
    });
    expect(mutated).toContain('for (const item of users)');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      nPlusOneQueryTemplate.apply('a\nb', {
        type: 'n-plus-one-query',
        file: 'x.ts',
        line: 99,
      }),
    ).toThrow(/line/i);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      nPlusOneQueryTemplate.apply('a\nb', {
        type: 'n-plus-one-query',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
