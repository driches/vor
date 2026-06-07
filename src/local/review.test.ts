import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorInput, OrchestratorOutput } from '../orchestrator.js';
import { NothingToReviewError, runLocalReview } from './review.js';

function g(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

const cannedResult: OrchestratorOutput = {
  comment_count: 0,
  ended: 'summary_posted',
  turns: 1,
  cost_usd: 0,
  dry_run: true,
  kept_comments: [],
};

describe('runLocalReview', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vor-review-'));
    g(repo, ['init', '-q']);
    g(repo, ['config', 'user.email', 'test@example.com']);
    g(repo, ['config', 'user.name', 'Test']);
    g(repo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'first']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'second']);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('runs a range review and returns a populated record', async () => {
    const spy = vi.fn(async (_in: OrchestratorInput) => cannedResult);
    const rec = await runLocalReview(
      { workspace: repo, target: 'range', base: 'HEAD~1', head: 'HEAD' },
      { runOrchestratorImpl: spy },
    );
    expect(spy).toHaveBeenCalledOnce();
    const passed = spy.mock.calls[0]![0];
    expect(passed.dry_run).toBe(true);
    expect(passed.workspace_dir).toBe(repo);
    expect(rec.target).toBe('range');
    expect(rec.files).toBe(1);
    expect(rec.head.ref).toBe('HEAD');
    expect(rec.result).toEqual(cannedResult);
  });

  it('reviews the working tree and reads head content from disk', async () => {
    writeFileSync(join(repo, 'a.ts'), 'export const a = 999;\n');
    let headContent: string | null = null;
    const spy = vi.fn(async (input: OrchestratorInput) => {
      // The orchestrator reads head content via getContent at the head SHA.
      const res = await input.octokitFactory!({ auth: 'x' }).rest.repos.getContent({
        owner: 'local',
        repo: 'local',
        path: 'a.ts',
      });
      const data = res.data as { content: string; encoding: string };
      headContent = Buffer.from(data.content, 'base64').toString('utf-8');
      return cannedResult;
    });
    const rec = await runLocalReview(
      { workspace: repo, target: 'working-tree' },
      { runOrchestratorImpl: spy },
    );
    expect(rec.target).toBe('working-tree');
    expect(rec.head.sha).toBeNull();
    expect(headContent).toBe('export const a = 999;\n');
    // restore
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  });

  it('throws NothingToReviewError when base and head are identical', async () => {
    await expect(
      runLocalReview({ workspace: repo, target: 'range', base: 'HEAD', head: 'HEAD' }),
    ).rejects.toBeInstanceOf(NothingToReviewError);
  });
});
