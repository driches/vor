import { describe, expect, it } from 'vitest';
import { pathTraversalTemplate } from './path-traversal.js';
import type { PlantConfig } from '../eval/types.js';

describe('pathTraversalTemplate', () => {
  it('inserts an unsanitized fs.readFile(path.join(...)) call', () => {
    const source = ['line1', 'line2', 'line3'].join('\n');
    const { mutated, truth } = pathTraversalTemplate.apply(source, {
      type: 'path-traversal',
      file: 'src/routes/files.ts',
      line: 2,
    });
    expect(mutated).toContain('fs.readFile(path.join(baseDir, filename)');
    expect(truth).toEqual({
      file: 'src/routes/files.ts',
      line_range: [2, 2],
      bug_type: 'path-traversal',
      severity: 'critical',
      category: ['security', 'bug'],
    });
  });

  it('honors custom input_var and base_var names', () => {
    const { mutated } = pathTraversalTemplate.apply('a\nb\n', {
      type: 'path-traversal',
      file: 'x.ts',
      line: 1,
      input_var: 'userPath',
      base_var: 'rootDir',
    });
    expect(mutated).toContain('path.join(rootDir, userPath)');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      pathTraversalTemplate.apply('a\nb', {
        type: 'path-traversal',
        file: 'x.ts',
        line: 99,
      }),
    ).toThrow(/line/i);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      pathTraversalTemplate.apply('a\nb', {
        type: 'path-traversal',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
