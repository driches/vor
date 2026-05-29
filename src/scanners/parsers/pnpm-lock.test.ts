import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { pnpmLockParser } from './pnpm-lock.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'pnpm-lock.yaml',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'yaml',
    is_generated: true,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('pnpmLockParser.matches', () => {
  it('matches pnpm-lock.yaml at any depth', () => {
    expect(pnpmLockParser.matches(makeFile({ path: 'pnpm-lock.yaml' }))).toBe(true);
    expect(pnpmLockParser.matches(makeFile({ path: 'apps/web/pnpm-lock.yaml' }))).toBe(true);
  });

  it('does not match other lockfiles', () => {
    expect(pnpmLockParser.matches(makeFile({ path: 'yarn.lock' }))).toBe(false);
    expect(pnpmLockParser.matches(makeFile({ path: 'package-lock.json' }))).toBe(false);
  });
});

describe('pnpmLockParser.parse', () => {
  it('returns [] on malformed YAML', () => {
    expect(pnpmLockParser.parse(': bad : yaml :')).toEqual([]);
  });

  it('returns [] when packages section is missing', () => {
    expect(pnpmLockParser.parse('lockfileVersion: 6.0\n')).toEqual([]);
  });

  it('parses lockfile v6 keys (name@version, including scoped packages)', () => {
    const content = [
      "lockfileVersion: '6.0'",
      '',
      'packages:',
      '',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: sha512-foo}',
      '    dev: false',
      '',
      '  /@scope/pkg@2.0.4:',
      '    resolution: {integrity: sha512-bar}',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    expect(deps).toHaveLength(2);

    const lodash = deps.find((d) => d.name === 'lodash');
    const scoped = deps.find((d) => d.name === '@scope/pkg');

    expect(lodash).toBeDefined();
    expect(lodash!.ecosystem).toBe('npm');
    expect(lodash!.version).toBe('4.17.21');
    expect(lodash!.line).toBe(5);

    expect(scoped).toBeDefined();
    expect(scoped!.version).toBe('2.0.4');
    expect(scoped!.line).toBe(9);
  });

  it('parses lockfile v5 keys (name/version)', () => {
    const content = [
      'lockfileVersion: 5.4',
      '',
      'packages:',
      '',
      '  /lodash/4.17.21:',
      '    resolution:',
      '      integrity: sha512-...',
      '',
      '  /@scope/pkg/2.0.4:',
      '    resolution:',
      '      integrity: sha512-...',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    expect(deps).toHaveLength(2);
    const lodash = deps.find((d) => d.name === 'lodash');
    expect(lodash!.version).toBe('4.17.21');
    const scoped = deps.find((d) => d.name === '@scope/pkg');
    expect(scoped!.version).toBe('2.0.4');
  });

  it('strips v6 peer-dep id suffixes like (react@18.0.0) and dedupes', () => {
    const content = [
      "lockfileVersion: '6.0'",
      'packages:',
      '  /button@1.0.0(react@18.0.0):',
      '    resolution: {integrity: x}',
      '  /button@1.0.0(react@17.0.0):',
      '    resolution: {integrity: x}',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.name).toBe('button');
    expect(deps[0]!.version).toBe('1.0.0');
  });

  it('resolves unscoped npm:alias keys to the real package name', () => {
    // Regression: previously `/lodash-old@npm:lodash@3.10.1` returned
    // (name='lodash-old', version='npm:lodash@3.10.1'). OSV is keyed to
    // the real package (`lodash`), so the alias label can't drive lookups.
    const content = [
      "lockfileVersion: '6.0'",
      'packages:',
      '  /lodash-old@npm:lodash@3.10.1:',
      '    resolution: {integrity: x}',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    expect(deps).toEqual([{ ecosystem: 'npm', name: 'lodash', version: '3.10.1', line: 3 }]);
  });

  it('resolves scoped npm:alias targets', () => {
    const content = [
      "lockfileVersion: '6.0'",
      'packages:',
      '  /my-react@npm:@scope/real@1.0.0:',
      '    resolution: {integrity: x}',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    expect(deps).toEqual([{ ecosystem: 'npm', name: '@scope/real', version: '1.0.0', line: 3 }]);
  });

  it('leaves non-alias entries unchanged when the lockfile mixes both', () => {
    const content = [
      "lockfileVersion: '6.0'",
      'packages:',
      '  /lodash@4.17.21:',
      '    resolution: {integrity: x}',
      '  /lodash-old@npm:lodash@3.10.1:',
      '    resolution: {integrity: x}',
      '',
    ].join('\n');

    const deps = pnpmLockParser.parse(content);
    // Both entries resolve to `lodash` (different versions) — dedup keys on
    // (name, version), so both survive.
    expect(deps.map((d) => `${d.name}@${d.version}`).sort()).toEqual([
      'lodash@3.10.1',
      'lodash@4.17.21',
    ]);
  });
});
