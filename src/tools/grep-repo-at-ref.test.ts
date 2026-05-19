import { describe, expect, it } from 'vitest';
import { makeGrepRepoAtRefTool } from './grep-repo-at-ref.js';
import { buildFakeDeps, callTool, getResultJson } from './test-helpers.js';

/**
 * These tests shell out to `git grep` against the current repo (cwd).
 * They assert structural properties of the result, not specific matches,
 * so they're resilient to repo content changes.
 */
describe('grep_repo_at_ref tool', () => {
  it('returns matches for a pattern that exists in the repo', async () => {
    const deps = buildFakeDeps({ workspaceDir: process.cwd() });
    const tool = makeGrepRepoAtRefTool(deps);
    const r = getResultJson(
      await callTool(tool, {
        pattern: 'AGENT_REVIEW_MARKER',
        ref: 'head',
        max_results: 20,
        case_sensitive: true,
      }),
    ) as { matches: unknown[]; total: number };
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it('returns empty matches for a pattern that does not exist', async () => {
    const deps = buildFakeDeps({ workspaceDir: process.cwd() });
    const tool = makeGrepRepoAtRefTool(deps);
    // Build the pattern at runtime so the literal string isn't in source
    const pattern = ['z', 'qq', 'no', 'such', 'sym', 'inrepo'].join('_') + '_zzz';
    const r = getResultJson(
      await callTool(tool, {
        pattern,
        ref: 'head',
        max_results: 20,
        case_sensitive: true,
      }),
    ) as { matches: unknown[] };
    expect(r.matches).toEqual([]);
  });

  it('caps results at max_results', async () => {
    const deps = buildFakeDeps({ workspaceDir: process.cwd() });
    const tool = makeGrepRepoAtRefTool(deps);
    const r = getResultJson(
      await callTool(tool, {
        pattern: 'import',
        ref: 'head',
        max_results: 3,
        case_sensitive: true,
      }),
    ) as { matches: unknown[]; truncated: boolean };
    expect(r.matches.length).toBeLessThanOrEqual(3);
  });
});
