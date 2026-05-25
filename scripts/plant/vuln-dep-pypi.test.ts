import { describe, expect, it } from 'vitest';
import { vulnDepPypiTemplate } from './vuln-dep-pypi.js';
import type { PlantConfig } from '../eval/types.js';

describe('vulnDepPypiTemplate', () => {
  it('updates an existing requirement line to the planted version', () => {
    const source = ['flask==2.3.0', 'requests==2.28.0', 'pytest==8.0.0', ''].join('\n');
    const { mutated, truth } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    const lines = mutated.split('\n');
    expect(lines[1]).toBe('requests==2.5.0');
    // Other lines untouched.
    expect(lines[0]).toBe('flask==2.3.0');
    expect(lines[2]).toBe('pytest==8.0.0');
    // Trailing newline preserved.
    expect(mutated.endsWith('\n')).toBe(true);
    expect(truth).toEqual({
      file: 'requirements.txt',
      line_range: [2, 2],
      bug_type: 'vuln-dep:pypi:requests@2.5.0',
      severity: 'critical',
      category: ['vulnerability'],
    });
  });

  it('appends a new requirement line when the package is not yet present', () => {
    const source = ['flask==2.3.0', 'pytest==8.0.0', ''].join('\n');
    const { mutated, truth } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toBe('requests==2.5.0');
    expect(truth.line_range).toEqual([3, 3]);
  });

  it('matches package names case-insensitively (PEP 503 normalization)', () => {
    // pip treats Django/django, oauth-lib/oauth_lib/OAuth.Lib as the same name.
    const source = ['Django==4.2.0', ''].join('\n');
    const { mutated } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'django',
      version: '2.0.0',
    });
    expect(mutated.split('\n')[0]).toBe('django==2.0.0');
  });

  it('rejects a no-op plant when the same package==version is already pinned', () => {
    // Same rationale as vuln-dep:npm — a no-op mutation produces an identical
    // after/, the diff drops the file, and the truth scores as a guaranteed FN.
    const source = ['requests==2.5.0', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'requests',
        version: '2.5.0',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('detects no-op pins under PEP 503 name normalization (capitalization)', () => {
    // Regression for PR #19 Codex P2 3299774234. Before the fix, the no-op
    // guard compared raw line text to `${pkg}==${ver}`, so a capitalized
    // existing line was rewritten in-place — same package, same version,
    // only the casing changed. The OSV scanner sees an unchanged vulnerable
    // pin in both before/ and after/, but the truth entry would credit the
    // detection to the planted bug, inflating TP. Compare parsed (name,
    // version) instead so the canonicalized no-op is caught.
    const source = ['Requests==2.5.0', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'requests',
        version: '2.5.0',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('detects no-op pins under PEP 503 name normalization (separators)', () => {
    // `oauth_lib` and `oauth-lib` are the same distribution per PEP 503.
    const source = ['oauth-lib==2.5.0', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'oauth_lib',
        version: '2.5.0',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('detects no-op pins when the operator has surrounding whitespace', () => {
    // pip accepts `requests == 2.5.0` (with spaces) as identical to the
    // tight form. The regex parses both shapes identically, so the no-op
    // comparison should catch this too.
    const source = ['requests  ==  2.5.0', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'requests',
        version: '2.5.0',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('detects no-op pins under PEP 440 release-segment equivalence (existing 2.5 vs planted 2.5.0)', () => {
    // Regression for PR #19 Codex P2 3299840874. PEP 440 zero-pads release
    // segments under `==`, so `requests==2.5` already pins requests at
    // 2.5.0. Planting `requests==2.5.0` over it is semantically a no-op
    // (same resolved version); without canonicalization the template would
    // rewrite the line, the OSV scanner would still see requests@2.5.0 in
    // after/, and the truth would inflate TP for a pre-existing vuln.
    const source = ['requests==2.5', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'requests',
        version: '2.5.0',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('detects no-op pins under PEP 440 release-segment equivalence (existing 2.5.0.0 vs planted 2.5)', () => {
    // Symmetric case: extra trailing .0 on the existing side.
    const source = ['requests==2.5.0.0', ''].join('\n');
    expect(() =>
      vulnDepPypiTemplate.apply(source, {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
        package: 'requests',
        version: '2.5',
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('does NOT treat semantically distinct PEP 440 versions as equivalent (2.5.1 vs 2.5)', () => {
    // Sanity: canonicalization must not over-match. `2.5.1` strips no
    // trailing zeros, so it stays distinct from `2.5` (which canonicalizes
    // to `2.5`). The plant proceeds normally.
    const source = ['requests==2.5.1', ''].join('\n');
    const { mutated } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5',
    });
    expect(mutated.split('\n')[0]).toBe('requests==2.5');
  });

  it('treats `===` (arbitrary-equality) operator as a real mutation, not a no-op', () => {
    // PEP 440 `===` is a different operator — it skips PEP 440 version
    // normalization. Rewriting `requests===2.5.0` as `requests==2.5.0` is
    // a semantic change, so it should plant normally and emit a truth.
    const source = ['requests===2.5.0', ''].join('\n');
    const { mutated, truth } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    expect(mutated.split('\n')[0]).toBe('requests==2.5.0');
    expect(truth.bug_type).toBe('vuln-dep:pypi:requests@2.5.0');
  });

  it('treats `~=` (compatible-release) as a valid operator distinct from `==`', () => {
    // Sanity check that the operator enumeration covers PEP 440's full set.
    // `~=2.5.0` means "compatible with 2.5.x" — not pinned to 2.5.0, so
    // rewriting it to `requests==2.5.0` is a real mutation.
    const source = ['requests~=2.5.0', ''].join('\n');
    const { mutated } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    expect(mutated.split('\n')[0]).toBe('requests==2.5.0');
  });

  it('falls through to append when the existing line uses a non-PEP-440 operator', () => {
    // Regression for PR #19 self-review on the regex shape. A malformed
    // line like `requests~2.5.0` (bare `~`, a typo for `~=`) is NOT a
    // valid PEP 440 requirement. The enumerated-operator regex correctly
    // rejects it, so the search loop finds no match and the plant
    // appends a fresh `requests==2.5.0` at the end. The malformed line
    // stays as-is — the case author's bug to fix, not the planter's.
    const source = ['requests~2.5.0', 'flask==2.3.0', ''].join('\n');
    const { mutated, truth } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    const lines = mutated.split('\n');
    // Original malformed line untouched.
    expect(lines[0]).toBe('requests~2.5.0');
    expect(lines[1]).toBe('flask==2.3.0');
    // New requirement appended at the end.
    expect(lines[2]).toBe('requests==2.5.0');
    expect(truth.line_range).toEqual([3, 3]);
  });

  it('treats `>=` range as a real mutation when planting the same version pin', () => {
    // An existing `requests>=2.5.0` allows but doesn't pin 2.5.0; rewriting
    // it as `requests==2.5.0` is a real lockfile-resolution change.
    const source = ['requests>=2.5.0', ''].join('\n');
    const { mutated } = vulnDepPypiTemplate.apply(source, {
      type: 'vuln-dep:pypi',
      file: 'requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    expect(mutated.split('\n')[0]).toBe('requests==2.5.0');
  });

  it('rejects a non-requirements.txt file', () => {
    expect(() =>
      vulnDepPypiTemplate.apply('', {
        type: 'vuln-dep:pypi',
        file: 'pyproject.toml',
        package: 'requests',
        version: '2.5.0',
      }),
    ).toThrow(/requirements\.txt/);
  });

  it('rejects missing package or version', () => {
    expect(() =>
      vulnDepPypiTemplate.apply('', {
        type: 'vuln-dep:pypi',
        file: 'requirements.txt',
      } as unknown as PlantConfig),
    ).toThrow(/package.*version/i);
  });

  it('accepts a path-prefixed requirements.txt (e.g. api/requirements.txt)', () => {
    // Mirror the npm template's allowance for nested package-lock.json paths.
    const { truth } = vulnDepPypiTemplate.apply('', {
      type: 'vuln-dep:pypi',
      file: 'api/requirements.txt',
      package: 'requests',
      version: '2.5.0',
    });
    expect(truth.file).toBe('api/requirements.txt');
  });
});
