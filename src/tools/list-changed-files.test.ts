import { describe, expect, it } from 'vitest';
import { makeListChangedFilesTool } from './list-changed-files.js';
import { buildFakeDeps, callTool, getResultJson, makeFile } from './test-helpers.js';

describe('list_changed_files tool', () => {
  it('returns the changed files with reviewable ranges', async () => {
    const deps = buildFakeDeps({
      files: [
        makeFile({ path: 'a.ts', reviewable_lines: [[5, 10]] }),
        makeFile({ path: 'b.ts', reviewable_lines: [[1, 3], [20, 22]] }),
      ],
    });
    const tool = makeListChangedFilesTool(deps);
    const result = await callTool(tool, {});
    const json = getResultJson(result) as Array<{
      path: string;
      reviewable_line_ranges: number[][];
      reviewable_line_ranges_formatted: string;
    }>;
    expect(json).toHaveLength(2);
    expect(json[0]!.path).toBe('a.ts');
    expect(json[0]!.reviewable_line_ranges).toEqual([[5, 10]]);
    expect(json[1]!.reviewable_line_ranges_formatted).toBe('1-3, 20-22');
  });

  it('returns empty array for PR with no files', async () => {
    const deps = buildFakeDeps({ files: [] });
    const tool = makeListChangedFilesTool(deps);
    const json = getResultJson(await callTool(tool, {})) as unknown[];
    expect(json).toEqual([]);
  });
});
