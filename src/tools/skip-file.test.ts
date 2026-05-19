import { describe, expect, it } from 'vitest';
import { makeSkipFileTool } from './skip-file.js';
import { buildFakeDeps, callTool, getResultJson, makeFile } from './test-helpers.js';

describe('skip_file tool', () => {
  it('accepts a file that is in the PR', async () => {
    const deps = buildFakeDeps({ files: [makeFile({ path: 'lock.lock', is_generated: true })] });
    const tool = makeSkipFileTool(deps);
    const result = await callTool(tool, { file_path: 'lock.lock', reason: 'lockfile' });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.snapshot().skipped).toHaveLength(1);
  });

  it('rejects a file not in the PR', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makeSkipFileTool(deps);
    const result = await callTool(tool, { file_path: 'not-in-pr.lock', reason: 'lockfile' });
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('not in this PR');
  });
});
