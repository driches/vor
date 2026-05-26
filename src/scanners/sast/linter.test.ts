import { describe, expect, it } from 'vitest';
import { filterShellSafePaths, normalizeToolPath } from './linter.js';

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

describe('filterShellSafePaths', () => {
  // Codex P1 regression test: PR-controlled filenames flow into spawn
  // argv. Without filtering: leading-dash paths become CLI flags (both
  // shell modes), and shell-mode raw paths split tokens on spaces and
  // can carry metacharacter injection.

  describe('non-shell mode', () => {
    it('passes plain paths through unchanged', () => {
      const r = filterShellSafePaths(['src/foo.ts', 'lib/bar.py'], false);
      expect(r.safe).toEqual(['src/foo.ts', 'lib/bar.py']);
      expect(r.dropped).toEqual([]);
    });

    it('drops leading-dash paths (option-confusion guard)', () => {
      const r = filterShellSafePaths(['src/foo.ts', '--evil=value', '-rf'], false);
      expect(r.safe).toEqual(['src/foo.ts']);
      expect(r.dropped).toEqual(['--evil=value', '-rf']);
    });

    it('passes spaces and other characters through in non-shell mode', () => {
      // Node passes argv directly to execve when shell:false — no tokenizing.
      const r = filterShellSafePaths(['src/my file.ts'], false);
      expect(r.safe).toEqual(['src/my file.ts']);
      expect(r.dropped).toEqual([]);
    });
  });

  describe('shell mode (Windows .cmd shim)', () => {
    it('quotes spaces so cmd.exe treats them as one token', () => {
      const r = filterShellSafePaths(['src/my file.ts'], true);
      expect(r.safe).toEqual(['"src/my file.ts"']);
      expect(r.dropped).toEqual([]);
    });

    it('drops shell metacharacter paths', () => {
      const r = filterShellSafePaths(
        ['src/foo.ts', 'src/evil & whoami.ts', 'src/$(cat etc.ts)'],
        true,
      );
      expect(r.safe).toEqual(['"src/foo.ts"']);
      expect(r.dropped).toContain('src/evil & whoami.ts');
      expect(r.dropped).toContain('src/$(cat etc.ts)');
    });

    it('drops leading-dash paths even in shell mode', () => {
      const r = filterShellSafePaths(['--evil=value', 'src/foo.ts'], true);
      expect(r.safe).toEqual(['"src/foo.ts"']);
      expect(r.dropped).toEqual(['--evil=value']);
    });

    it('drops empty strings', () => {
      const r = filterShellSafePaths(['', 'src/foo.ts'], true);
      expect(r.safe).toEqual(['"src/foo.ts"']);
      expect(r.dropped).toEqual(['']);
    });
  });
});
