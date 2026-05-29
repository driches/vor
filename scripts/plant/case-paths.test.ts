import { describe, expect, it } from 'vitest';
import { resolveCaseDir } from './case-paths.js';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep, join } from 'node:path';

describe('resolveCaseDir', () => {
  it('resolves a normal case id to <goldenRepo>/cases/<id>', () => {
    const got = resolveCaseDir('/tmp/golden', 'demo');
    expect(got).toBe(resolve('/tmp/golden/cases/demo'));
  });

  it('rejects path traversal via "../"', () => {
    expect(() => resolveCaseDir('/tmp/golden', '../escape')).toThrow(/resolves outside cases root/);
  });

  it('rejects deep path traversal via "../../"', () => {
    // `--case ../../tmp/x` would resolve to /tmp/x (outside /tmp/golden/cases).
    expect(() => resolveCaseDir('/tmp/golden', '../../tmp/x')).toThrow(
      /resolves outside cases root/,
    );
  });

  it('rejects an empty case id (resolves to cases root itself)', () => {
    // `resolve('/tmp/golden/cases', '')` === '/tmp/golden/cases', which would
    // make `runPlants` operate on the parent of every real case. Reject.
    expect(() => resolveCaseDir('/tmp/golden', '')).toThrow(/must name a specific case directory/);
  });

  it('rejects a case id that points exactly at the cases root via "."', () => {
    expect(() => resolveCaseDir('/tmp/golden', '.')).toThrow(/must name a specific case directory/);
  });

  it('allows nested case ids (e.g. "group/case-1")', () => {
    // Subdirectories under cases/ are legitimate organisational choices and
    // must NOT be confused with traversal escapes.
    const got = resolveCaseDir('/tmp/golden', 'group/case-1');
    expect(got).toBe(resolve(`/tmp/golden/cases${sep}group${sep}case-1`));
  });

  it('rejects a symlinked case directory that points outside the golden tree', () => {
    // Regression for PR #10 Codex P1 3295120950. The lexical
    // resolve+startsWith check passes a `cases/<id>` symlink that points
    // outside the golden tree. runPlants would then follow the symlink and
    // destructively rmSync in the target. realpath both sides and re-check.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'case-paths-symlink-'));
    try {
      const goldenRepo = join(tmpRoot, 'golden');
      const outsideTarget = join(tmpRoot, 'outside');
      mkdirSync(join(goldenRepo, 'cases'), { recursive: true });
      mkdirSync(outsideTarget, { recursive: true });
      // Plant a benign file in the outside target so we can confirm the
      // symlink resolves correctly.
      writeFileSync(join(outsideTarget, 'sentinel.txt'), 'do not delete\n');
      // Create the malicious symlink: cases/evil -> /tmp/.../outside
      symlinkSync(outsideTarget, join(goldenRepo, 'cases', 'evil'));
      expect(() => resolveCaseDir(goldenRepo, 'evil')).toThrow(/symlink.*outside cases root/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('allows a symlinked case directory that points to another path INSIDE cases/', () => {
    // Sanity check: not every symlink is malicious. A legitimate use is
    // `cases/alias -> cases/real-case` for cross-referencing organised
    // case groups. After realpath, both ends still share the cases/ root.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'case-paths-symlink-ok-'));
    try {
      const goldenRepo = join(tmpRoot, 'golden');
      const realCase = join(goldenRepo, 'cases', 'real-case');
      mkdirSync(realCase, { recursive: true });
      symlinkSync(realCase, join(goldenRepo, 'cases', 'alias'));
      // Should NOT throw — the symlink resolves inside cases/ root.
      const got = resolveCaseDir(goldenRepo, 'alias');
      expect(got).toBe(resolve(join(goldenRepo, 'cases', 'alias')));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
