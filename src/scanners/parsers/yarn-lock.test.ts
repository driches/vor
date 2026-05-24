import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { yarnLockParser } from './yarn-lock.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'yarn.lock',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'plaintext',
    is_generated: true,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('yarnLockParser.matches', () => {
  it('matches files named yarn.lock (at any depth)', () => {
    expect(yarnLockParser.matches(makeFile({ path: 'yarn.lock' }))).toBe(true);
    expect(yarnLockParser.matches(makeFile({ path: 'apps/web/yarn.lock' }))).toBe(true);
  });

  it('does not match other lockfiles', () => {
    expect(yarnLockParser.matches(makeFile({ path: 'package-lock.json' }))).toBe(false);
    expect(yarnLockParser.matches(makeFile({ path: 'pnpm-lock.yaml' }))).toBe(false);
  });
});

describe('yarnLockParser.parse', () => {
  it('returns [] for empty input', () => {
    expect(yarnLockParser.parse('')).toEqual([]);
  });

  it('parses a minimal fixture with a regular package, a scoped package, and a multi-spec header', () => {
    const content = [
      '# yarn lockfile v1',
      '',
      '',
      'lodash@^4.17.20:',
      '  version "4.17.21"',
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
      '  integrity sha512-...',
      '',
      '"@scope/pkg@^2.0.0":',
      '  version "2.0.4"',
      '  resolved "https://..."',
      '',
      '"debug@^4.0.0", "debug@^4.1.0":',
      '  version "4.3.4"',
      '  resolved "..."',
      '',
    ].join('\n');

    const deps = yarnLockParser.parse(content);
    expect(deps).toHaveLength(3);

    const lodash = deps.find((d) => d.name === 'lodash');
    const scoped = deps.find((d) => d.name === '@scope/pkg');
    const debug = deps.find((d) => d.name === 'debug');

    expect(lodash).toBeDefined();
    expect(lodash!.ecosystem).toBe('npm');
    expect(lodash!.version).toBe('4.17.21');
    expect(lodash!.line).toBe(5);

    expect(scoped).toBeDefined();
    expect(scoped!.version).toBe('2.0.4');
    // `@scope/pkg` header is at line 9; version is at line 10.
    expect(scoped!.line).toBe(10);

    expect(debug).toBeDefined();
    expect(debug!.version).toBe('4.3.4');
  });

  it('skips records that have no version body', () => {
    const content = ['no-version-pkg@^1.0.0:', '  resolved "https://..."', ''].join('\n');
    expect(yarnLockParser.parse(content)).toEqual([]);
  });

  it('does not drop the next entry when the previous record lacks a version line', () => {
    // Regression: previously, when the inner loop broke because it hit the
    // next entry's header, `i` advanced past that header — silently dropping
    // the entry whose header was at line `j`.
    const content = [
      'foo@^1.0.0:',
      '  resolved "https://example.com/foo"',
      'bar@^2.0.0:',
      '  version "2.0.0"',
      '  resolved "https://example.com/bar"',
      '',
    ].join('\n');
    const deps = yarnLockParser.parse(content);
    expect(deps).toEqual([
      { ecosystem: 'npm', name: 'bar', version: '2.0.0', line: 4, header_line: 3 },
    ]);
  });

  it('handles CRLF line endings', () => {
    const content = ['lodash@^4.17.20:', '  version "4.17.21"', ''].join('\r\n');
    const deps = yarnLockParser.parse(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.name).toBe('lodash');
    expect(deps[0]!.version).toBe('4.17.21');
  });

  // -----------------------------------------------------------------
  // Yarn npm aliases — emit the REAL package name so OSV lookups hit
  // canonical advisory data instead of the alias label.
  // -----------------------------------------------------------------
  describe('npm aliases', () => {
    it('resolves an unscoped npm alias to the real package name', () => {
      const content = [
        '"my-react@npm:react@^18.0.0":',
        '  version "18.2.0"',
        '  resolved "https://example.com/react"',
        '',
      ].join('\n');
      const deps = yarnLockParser.parse(content);
      expect(deps).toEqual([
        { ecosystem: 'npm', name: 'react', version: '18.2.0', line: 2, header_line: 1 },
      ]);
    });

    it('resolves a scoped npm alias target', () => {
      const content = [
        '"alias@npm:@scope/real-package@^1.0.0":',
        '  version "1.2.3"',
        '  resolved "https://example.com/real"',
        '',
      ].join('\n');
      const deps = yarnLockParser.parse(content);
      expect(deps).toEqual([
        {
          ecosystem: 'npm',
          name: '@scope/real-package',
          version: '1.2.3',
          line: 2,
          header_line: 1,
        },
      ]);
    });

    it('leaves non-alias entries unchanged', () => {
      const content = [
        'lodash@^4.17.20:',
        '  version "4.17.21"',
        '',
        '"@types/node@^20.0.0":',
        '  version "20.5.0"',
        '',
      ].join('\n');
      const deps = yarnLockParser.parse(content);
      expect(deps.map((d) => d.name).sort()).toEqual(['@types/node', 'lodash']);
    });
  });

  it('exposes header_line distinct from line so dep-cve can match header-only additions', () => {
    // Regression: when a yarn PR only adds a new selector to an existing
    // entry's header (the body's `version "..."` line stays as context),
    // dep-cve's `added_lines.has(d.line)` filter dropped the dep — the
    // version line wasn't in added_lines. Now the parser also emits
    // `header_line`, and the dep-cve filter accepts the dep if EITHER
    // line was added.
    const content = [
      'lodash@^4.17.20:', // line 1 — header
      '  version "4.17.21"', // line 2 — version body
      '  resolved "https://..."', // line 3
      '',
    ].join('\n');
    const deps = yarnLockParser.parse(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.line).toBe(2);
    expect(deps[0]!.header_line).toBe(1);
  });
});
