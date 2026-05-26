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
});
