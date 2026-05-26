import { describe, expect, it } from 'vitest';
import { missingNullCheckTemplate } from './missing-null-check.js';
import type { PlantConfig } from '../eval/types.js';

describe('missingNullCheckTemplate', () => {
  it('replaces the marker line with the unchecked dereference', () => {
    const source = [
      'async function handle(): Promise<string> {',
      '  const result = await fetchProfile();',
      '  // PLANT_ANCHOR: missing-null-check',
      '  return name;',
      '}',
    ].join('\n');
    const { mutated, truth } = missingNullCheckTemplate.apply(source, {
      type: 'missing-null-check',
      file: 'src/handlers/profile.ts',
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toBe('  const name = result.user.name;');
    expect(truth).toEqual({
      file: 'src/handlers/profile.ts',
      line_range: [3, 3],
      bug_type: 'missing-null-check',
      severity: 'important',
      category: ['bug', 'error-handling'],
    });
  });

  it('throws when the marker is missing', () => {
    expect(() =>
      missingNullCheckTemplate.apply('a\nb\n', {
        type: 'missing-null-check',
        file: 'x.ts',
      }),
    ).toThrow(/marker .* not found/);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      missingNullCheckTemplate.apply(
        '// PLANT_ANCHOR: missing-null-check\n',
        { type: 'missing-null-check' } as unknown as PlantConfig,
      ),
    ).toThrow(/missing or empty 'file'/);
  });
});
