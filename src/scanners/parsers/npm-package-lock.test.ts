import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { npmPackageLockParser } from './npm-package-lock.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'package-lock.json',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    language: 'json',
    is_generated: true,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('npmPackageLockParser.matches', () => {
  it('matches files named exactly package-lock.json (at any depth)', () => {
    expect(npmPackageLockParser.matches(makeFile({ path: 'package-lock.json' }))).toBe(true);
    expect(npmPackageLockParser.matches(makeFile({ path: 'apps/web/package-lock.json' }))).toBe(
      true,
    );
  });

  it('does not match other lockfile types', () => {
    expect(npmPackageLockParser.matches(makeFile({ path: 'yarn.lock' }))).toBe(false);
    expect(npmPackageLockParser.matches(makeFile({ path: 'pnpm-lock.yaml' }))).toBe(false);
    expect(npmPackageLockParser.matches(makeFile({ path: 'package.json' }))).toBe(false);
  });
});

describe('npmPackageLockParser.parse', () => {
  it('returns [] on malformed JSON', () => {
    expect(npmPackageLockParser.parse('{ not json')).toEqual([]);
  });

  it('returns [] when packages map is missing', () => {
    expect(npmPackageLockParser.parse(JSON.stringify({ name: 'x', version: '1.0.0' }))).toEqual([]);
  });

  it('extracts a direct and a nested dep, skips the root entry', () => {
    // The literal JSON content is also used for line-anchoring, so build it
    // with predictable line breaks rather than JSON.stringify.
    const content = [
      '{',
      '  "name": "my-app",',
      '  "version": "0.1.0",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": {',
      '      "name": "my-app",',
      '      "version": "0.1.0"',
      '    },',
      '    "node_modules/lodash": {',
      '      "version": "4.17.20",',
      '      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"',
      '    },',
      '    "node_modules/lodash/node_modules/debug": {',
      '      "version": "4.3.4",',
      '      "resolved": "https://registry.npmjs.org/debug/-/debug-4.3.4.tgz"',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const deps = npmPackageLockParser.parse(content);
    expect(deps).toHaveLength(2);

    const lodash = deps.find((d) => d.name === 'lodash');
    const debug = deps.find((d) => d.name === 'debug');
    expect(lodash).toBeDefined();
    expect(debug).toBeDefined();
    expect(lodash!.ecosystem).toBe('npm');
    expect(lodash!.version).toBe('4.17.20');
    expect(debug!.version).toBe('4.3.4');

    // Best-effort line anchoring: should be on or after the package key
    // declaration line, and within a reasonable window of the actual version
    // record. (Lodash record starts around line 10; the version line is 11.)
    expect(lodash!.line).toBeGreaterThanOrEqual(10);
    expect(lodash!.line).toBeLessThanOrEqual(15);
    expect(debug!.line).toBeGreaterThanOrEqual(14);
  });

  it('handles scoped packages in the node_modules path', () => {
    const content = JSON.stringify(
      {
        packages: {
          '': { name: 'app' },
          'node_modules/@scope/pkg': { version: '2.0.0' },
        },
      },
      null,
      2,
    );
    const deps = npmPackageLockParser.parse(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.name).toBe('@scope/pkg');
    expect(deps[0]!.version).toBe('2.0.0');
  });

  it('skips entries without a version field', () => {
    const content = JSON.stringify({
      packages: {
        '': { name: 'app' },
        'node_modules/has-version': { version: '1.0.0' },
        'node_modules/no-version': { resolved: 'https://...' },
      },
    });
    const deps = npmPackageLockParser.parse(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.name).toBe('has-version');
  });
});
