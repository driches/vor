import { describe, expect, it } from 'vitest';
import { normalizeToolPath } from './linter.js';

describe('normalizeToolPath', () => {
  // Codex P1 regression test: ruff/knip/semgrep/actionlint emit
  // repo-relative paths in their JSON output. Pre-fix, every linter
  // module called `path.relative(workspaceDir, toolPath)` directly,
  // which on relative input produces a '../...' string that never
  // matches `changedFiles` — silently dropping every finding.
  it('passes a relative path through unchanged (the linter already gave us repo-relative)', () => {
    expect(normalizeToolPath('/work/repo', 'src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeToolPath('/work/repo', 'lib/handlers/main.dart')).toBe(
      'lib/handlers/main.dart',
    );
    expect(normalizeToolPath('/work/repo', '.github/workflows/ci.yml')).toBe(
      '.github/workflows/ci.yml',
    );
  });

  it('re-relativizes absolute paths against the workspace (eslint/dart format)', () => {
    expect(normalizeToolPath('/work/repo', '/work/repo/src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeToolPath('/work/repo', '/work/repo/lib/main.dart')).toBe(
      'lib/main.dart',
    );
  });

  it('normalizes away ./ and double separators on relative paths', () => {
    expect(normalizeToolPath('/work/repo', './src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeToolPath('/work/repo', 'src//foo.ts')).toBe('src/foo.ts');
  });

  it('handles workspace paths with trailing slashes correctly', () => {
    expect(normalizeToolPath('/work/repo/', '/work/repo/src/foo.ts')).toBe('src/foo.ts');
  });

  it('returns POSIX-style separators so it matches changedFiles keys (Windows safety)', () => {
    // changedFiles keys come from `git diff` which always uses '/'.
    // `path.relative` and `path.normalize` would return backslashes on
    // Windows; without the conversion, every sast finding silently drops
    // on Windows runners. Strings here are explicit "/" so the test is
    // platform-independent and would catch a regression even when run
    // on Linux/macOS (since the conversion logic is unconditional).
    expect(normalizeToolPath('/work/repo', 'src/foo.ts')).not.toContain('\\');
    expect(normalizeToolPath('/work/repo', '/work/repo/lib/main.dart')).not.toContain(
      '\\',
    );
    // The forward-slash output is the contract:
    expect(normalizeToolPath('/work/repo', '/work/repo/src/a/b/c.ts')).toBe(
      'src/a/b/c.ts',
    );
  });
});
