import { describe, expect, it } from 'vitest';
import { offByOneLoopTemplate } from './off-by-one-loop.js';
import type { PlantConfig } from '../eval/types.js';

describe('offByOneLoopTemplate', () => {
  it('replaces the marker line with the buggy loop and anchors truth there', () => {
    const source = [
      'function sumAll(arr: number[]): number {',
      '  let sum = 0;',
      '  // PLANT_ANCHOR: off-by-one-loop',
      '  return sum;',
      '}',
    ].join('\n');
    const { mutated, truth } = offByOneLoopTemplate.apply(source, {
      type: 'off-by-one-loop',
      file: 'src/util/sum.ts',
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toBe('  for (let i = 0; i <= arr.length; i++) { sum += arr[i]; }');
    // Other lines untouched.
    expect(lines[0]).toBe('function sumAll(arr: number[]): number {');
    expect(lines[3]).toBe('  return sum;');
    expect(truth).toEqual({
      file: 'src/util/sum.ts',
      line_range: [3, 3],
      bug_type: 'off-by-one-loop',
      severity: 'important',
      category: ['bug', 'error-handling', 'data-loss'],
    });
  });

  it('throws when the marker is missing', () => {
    expect(() =>
      offByOneLoopTemplate.apply('a\nb\n', {
        type: 'off-by-one-loop',
        file: 'x.ts',
      }),
    ).toThrow(/marker .* not found/);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      offByOneLoopTemplate.apply('// PLANT_ANCHOR: off-by-one-loop\n', {
        type: 'off-by-one-loop',
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
