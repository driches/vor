import { describe, expect, it } from 'vitest';
import { dirsForGoFiles, golangCategory, golangSeverity } from './golang.js';

// The Go module's bespoke logic that would regress silently: the
// file→package-directory mapping we feed golangci-lint (a wrong target
// makes it scan the wrong package and every finding drops at the
// changedFiles lookup) and the FromLinter→severity/category mapping
// (mis-mapping silently mis-prioritizes or mis-categorizes findings).
describe('dirsForGoFiles', () => {
  it('maps a nested file to its ./<dir> package target', () => {
    expect(dirsForGoFiles(['internal/foo/bar.go'])).toEqual(['./internal/foo']);
  });

  it('maps a root-level file to ./', () => {
    expect(dirsForGoFiles(['main.go'])).toEqual(['./']);
  });

  it('dedups files that share a package directory', () => {
    expect(dirsForGoFiles(['pkg/a.go', 'pkg/b.go', 'pkg/c.go'])).toEqual(['./pkg']);
  });

  it('returns one target per distinct directory', () => {
    expect(dirsForGoFiles(['cmd/app/main.go', 'internal/svc/svc.go', 'main.go'])).toEqual([
      './cmd/app',
      './internal/svc',
      './',
    ]);
  });

  it('uses POSIX separators regardless of input nesting depth', () => {
    expect(dirsForGoFiles(['a/b/c/d/e.go'])).toEqual(['./a/b/c/d']);
  });
});

describe('golangSeverity', () => {
  it('flags gosec findings as important', () => {
    expect(golangSeverity('gosec')).toBe('important');
  });

  it('flags bug-class linters as important', () => {
    for (const l of ['govet', 'staticcheck', 'errcheck', 'ineffassign', 'unused']) {
      expect(golangSeverity(l)).toBe('important');
    }
  });

  it('treats staticcheck SA rule codes as important', () => {
    expect(golangSeverity('SA1019')).toBe('important');
  });

  it('treats style/other linters as minor', () => {
    for (const l of ['revive', 'gofmt', 'goimports', 'gocritic', 'unknown']) {
      expect(golangSeverity(l)).toBe('minor');
    }
  });
});

describe('golangCategory', () => {
  it('maps gosec to vulnerability', () => {
    expect(golangCategory('gosec')).toBe('vulnerability');
  });

  it('maps bug-class linters to bug', () => {
    for (const l of ['govet', 'staticcheck', 'errcheck']) {
      expect(golangCategory(l)).toBe('bug');
    }
  });

  it('maps style/other linters to readability', () => {
    for (const l of ['revive', 'gofmt', 'unknown']) {
      expect(golangCategory(l)).toBe('readability');
    }
  });
});
