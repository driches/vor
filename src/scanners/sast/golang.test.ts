import { describe, expect, it } from 'vitest';
import {
  buildFinding,
  extractGoSubRule,
  golangCategory,
  golangSeverity,
  groupByGoModule,
  issuePathCandidates,
  nearestGoModuleRoot,
} from './golang.js';

function issue(over: { FromLinter?: string; Text?: string; line?: number; column?: number } = {}) {
  return {
    FromLinter: over.FromLinter ?? 'govet',
    Text: over.Text ?? 'something is wrong',
    Pos: { Filename: 'main.go', Line: over.line ?? 10, Column: over.column ?? 0 },
  };
}

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

describe('issuePathCandidates', () => {
  it('returns the single as-reported key for a root module', () => {
    expect(issuePathCandidates('/ws', '.', 'main.go')).toEqual(['main.go']);
  });

  it('tries the module-rooted key first, then the as-reported key', () => {
    // wd/gomod mode reports `main.go` from backend/ → backend/main.go.
    // cfg mode (root config) reports `backend/main.go` already.
    expect(issuePathCandidates('/ws', 'backend', 'main.go')).toEqual([
      'backend/main.go',
      'main.go',
    ]);
  });

  it('prefers the as-reported key when the path already starts with the module root (cfg mode)', () => {
    // golangci reports `backend/api/h.go` relative to a repo-root config —
    // already workspace-relative. Trying the module-rooted guess
    // (backend/backend/api/h.go) first could mis-attach to a real nested
    // file on a line collision, so the as-reported key comes first.
    expect(issuePathCandidates('/ws', 'backend', 'backend/api/h.go')).toEqual([
      'backend/api/h.go',
      'backend/backend/api/h.go',
    ]);
  });

  it('relativizes an absolute path against the workspace', () => {
    expect(issuePathCandidates('/ws', 'backend', '/ws/backend/main.go')).toEqual([
      'backend/main.go',
    ]);
  });
});

describe('extractGoSubRule', () => {
  it('extracts the prefixed check name for linters that emit one', () => {
    expect(extractGoSubRule('printf: Printf format %d has arg s of wrong type')).toBe('printf');
    expect(extractGoSubRule('SA1019: foo is deprecated')).toBe('SA1019');
    expect(extractGoSubRule('G404: use of weak random')).toBe('G404');
    expect(extractGoSubRule('var-naming: var x should be X')).toBe('var-naming');
  });

  it('returns "" for plain-sentence messages with no code prefix', () => {
    expect(extractGoSubRule('Error return value of `x.Close` is not checked')).toBe('');
    expect(extractGoSubRule('should rewrite this loop')).toBe('');
  });
});

describe('buildFinding rule_id / fingerprint discrimination', () => {
  it('keeps two different sub-checks from one linter on the same line distinct', () => {
    const a = buildFinding('main.go', issue({ Text: 'printf: bad format', column: 5 }));
    const b = buildFinding('main.go', issue({ Text: 'shadow: declaration shadows x', column: 5 }));
    expect(a.rule_id).not.toBe(b.rule_id);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.rule_id).toBe('golangci-lint/govet:printf.c5');
  });

  it('keeps two prefix-less diagnostics at different columns distinct', () => {
    const a = buildFinding(
      'main.go',
      issue({ FromLinter: 'errcheck', Text: 'unchecked', column: 3 }),
    );
    const b = buildFinding(
      'main.go',
      issue({ FromLinter: 'errcheck', Text: 'unchecked', column: 20 }),
    );
    expect(a.rule_id).not.toBe(b.rule_id);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('collapses a genuine repeat (same sub-check, same column)', () => {
    const a = buildFinding('main.go', issue({ Text: 'printf: bad format', column: 5 }));
    const b = buildFinding('main.go', issue({ Text: 'printf: bad format', column: 5 }));
    expect(a.rule_id).toBe(b.rule_id);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('omits the discriminator when there is neither a sub-check nor a column', () => {
    const f = buildFinding(
      'main.go',
      issue({ FromLinter: 'errcheck', Text: 'unchecked', column: 0 }),
    );
    expect(f.rule_id).toBe('golangci-lint/errcheck');
    expect(f.fingerprint).toBe('golangci-lint:errcheck:main.go:10');
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
