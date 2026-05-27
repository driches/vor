import { describe, expect, it } from 'vitest';
import { syncInAsyncLoopTemplate } from './sync-in-async-loop.js';
import type { PlantConfig } from '../eval/types.js';

describe('syncInAsyncLoopTemplate', () => {
  it('replaces the marker line with the buggy forEach', () => {
    const source = [
      'async function processBatch(items: Item[]): Promise<void> {',
      '  // PLANT_ANCHOR: sync-in-async-loop',
      '  console.log("done");',
      '}',
    ].join('\n');
    const { mutated, truth } = syncInAsyncLoopTemplate.apply(source, {
      type: 'sync-in-async-loop',
      file: 'src/jobs/batch.ts',
    });
    const lines = mutated.split('\n');
    expect(lines[1]).toBe(
      '  items.forEach(async (item) => { await processOne(item); });',
    );
    expect(truth).toEqual({
      file: 'src/jobs/batch.ts',
      line_range: [2, 2],
      bug_type: 'sync-in-async-loop',
      severity: 'important',
      category: ['performance', 'bug', 'error-handling', 'race-condition'],
    });
  });

  it('throws when the marker is missing', () => {
    expect(() =>
      syncInAsyncLoopTemplate.apply('a\nb\n', {
        type: 'sync-in-async-loop',
        file: 'x.ts',
      }),
    ).toThrow(/marker .* not found/);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      syncInAsyncLoopTemplate.apply(
        '// PLANT_ANCHOR: sync-in-async-loop\n',
        { type: 'sync-in-async-loop' } as unknown as PlantConfig,
      ),
    ).toThrow(/missing or empty 'file'/);
  });
});
