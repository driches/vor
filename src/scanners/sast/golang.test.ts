import { describe, expect, it } from 'vitest';
import { golangCategory, golangSeverity, groupByGoModule, nearestGoModuleRoot } from './golang.js';

// The Go module's bespoke logic that would regress silently: the
// file→module-root attribution and package-target derivation we feed
// golangci-lint (a wrong root/target makes it scan the wrong place and
// every finding drops at the changedFiles lookup) and the
// FromLinter→severity/category mapping (mis-mapping silently
// mis-prioritizes or mis-categorizes findings).
describe('nearestGoModuleRoot', () => {
  it('returns "." when no go.mod exists anywhere', () => {
    expect(nearestGoModuleRoot('internal/foo', () => false)).toBe('.');
  });

  it('returns "." for a root go.mod', () => {
    const hasGoMod = (d: string) => d === '.';
    // walk only inspects ancestor dirs (not "."), so a root-only module
    // falls through to the "." default — which is what we want.
    expect(nearestGoModuleRoot('internal/foo', hasGoMod)).toBe('.');
  });

  it('returns the nearest subdirectory module', () => {
    const hasGoMod = (d: string) => d === 'backend';
    expect(nearestGoModuleRoot('backend/api/handlers', hasGoMod)).toBe('backend');
  });

  it('prefers the deepest matching module when modules nest', () => {
    const hasGoMod = (d: string) => d === 'backend' || d === 'backend/svc';
    expect(nearestGoModuleRoot('backend/svc/pkg', hasGoMod)).toBe('backend/svc');
  });
});

describe('groupByGoModule', () => {
  it('groups a single root module with deduped, per-directory targets', () => {
    const hasGoMod = (d: string) => d === '.';
    expect(
      groupByGoModule(['cmd/app/main.go', 'pkg/a.go', 'pkg/b.go', 'main.go'], hasGoMod),
    ).toEqual([{ root: '.', dirs: ['./cmd/app', './pkg', './'] }]);
  });

  it('roots a subdirectory module at its go.mod with targets relative to it', () => {
    const hasGoMod = (d: string) => d === 'backend';
    expect(groupByGoModule(['backend/api/h.go', 'backend/main.go'], hasGoMod)).toEqual([
      { root: 'backend', dirs: ['./api', './'] },
    ]);
  });

  it('splits files across multiple modules', () => {
    const hasGoMod = (d: string) => d === 'backend' || d === 'tools';
    expect(groupByGoModule(['backend/a.go', 'tools/gen/g.go', 'scripts/x.go'], hasGoMod)).toEqual([
      { root: 'backend', dirs: ['./'] },
      { root: 'tools', dirs: ['./gen'] },
      // No go.mod ancestor → repo-root group, target keeps its full path.
      { root: '.', dirs: ['./scripts'] },
    ]);
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
