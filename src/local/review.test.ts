import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorInput, OrchestratorOutput } from '../orchestrator.js';
import { NothingToReviewError, runLocalReview } from './review.js';

function g(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function gOut(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
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

  it('uses merge-base (three-dot) so base-side advances are not counted', async () => {
    const r = mkdtempSync(join(tmpdir(), 'vor-mb-'));
    g(r, ['init', '-q']);
    g(r, ['config', 'user.email', 'test@example.com']);
    g(r, ['config', 'user.name', 'Test']);
    g(r, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 1;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'c0']);
    g(r, ['branch', '-M', 'main']);
    // Feature branch adds one file.
    g(r, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(r, 'feature.ts'), 'export const f = 1;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'c1']);
    // Base advances after the split (edits a.ts) — must NOT appear in the diff.
    g(r, ['checkout', '-q', 'main']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 2;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'c2']);

    try {
      const spy = vi.fn(async (_in: OrchestratorInput) => cannedResult);
      const rec = await runLocalReview(
        { workspace: r, target: 'range', base: 'main', head: 'feature' },
        { runOrchestratorImpl: spy },
      );
      // Only feature.ts — not a.ts (a two-dot tip diff would report 2).
      expect(rec.files).toBe(1);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('materializes the head tree in a worktree when the checkout differs', async () => {
    const r = mkdtempSync(join(tmpdir(), 'vor-wt-'));
    g(r, ['init', '-q']);
    g(r, ['config', 'user.email', 'test@example.com']);
    g(r, ['config', 'user.name', 'Test']);
    g(r, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 1;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'first']);
    const firstSha = gOut(r, ['rev-parse', 'HEAD']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 2;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'second']);
    const secondSha = gOut(r, ['rev-parse', 'HEAD']);
    // Check out the OLD commit so the on-disk tree (v1) differs from head (v2).
    g(r, ['checkout', '-q', firstSha]);

    try {
      let seenWorkspace = '';
      let contentInTree = '';
      const spy = vi.fn(async (input: OrchestratorInput) => {
        seenWorkspace = input.workspace_dir;
        contentInTree = readFileSync(join(seenWorkspace, 'a.ts'), 'utf-8');
        return cannedResult;
      });
      await runLocalReview(
        { workspace: r, target: 'range', base: firstSha, head: secondSha },
        { runOrchestratorImpl: spy },
      );
      // Ran against a throwaway worktree holding the head tree, not the checkout.
      expect(seenWorkspace).not.toBe(r);
      expect(contentInTree).toBe('export const a = 2;\n');
      // Cleaned up after the run.
      expect(existsSync(seenWorkspace)).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('materializes a clean head tree when the checkout is at head but dirty', async () => {
    const r = mkdtempSync(join(tmpdir(), 'vor-dirty-'));
    g(r, ['init', '-q']);
    g(r, ['config', 'user.email', 'test@example.com']);
    g(r, ['config', 'user.name', 'Test']);
    g(r, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 1;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'first']);
    const firstSha = gOut(r, ['rev-parse', 'HEAD']);
    writeFileSync(join(r, 'a.ts'), 'export const a = 2;\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-qm', 'second']);
    const secondSha = gOut(r, ['rev-parse', 'HEAD']);
    // Stay at head, but dirty the working copy with an unrelated edit.
    writeFileSync(join(r, 'a.ts'), 'export const a = 999; // uncommitted\n');

    try {
      let seenWorkspace = '';
      let contentInTree = '';
      const spy = vi.fn(async (input: OrchestratorInput) => {
        seenWorkspace = input.workspace_dir;
        contentInTree = readFileSync(join(seenWorkspace, 'a.ts'), 'utf-8');
        return cannedResult;
      });
      await runLocalReview(
        { workspace: r, target: 'range', base: firstSha, head: secondSha },
        { runOrchestratorImpl: spy },
      );
      // Scanners saw the committed head (v2), not the dirty working copy.
      expect(seenWorkspace).not.toBe(r);
      expect(contentInTree).toBe('export const a = 2;\n');
      expect(existsSync(seenWorkspace)).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
