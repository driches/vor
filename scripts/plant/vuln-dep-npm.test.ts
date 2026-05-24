import { describe, expect, it } from 'vitest';
import { vulnDepNpmTemplate } from './vuln-dep-npm.js';

describe('vulnDepNpmTemplate', () => {
  it('inserts a package-lock.json entry for a known-vulnerable npm package', () => {
    const source = [
      '{',
      '  "name": "test",',
      '  "lockfileVersion": 3,',
      '  "packages": {',
      '    "": { "name": "test", "version": "1.0.0" }',
      '  }',
      '}',
      '',
    ].join('\n');
    const { mutated, truth } = vulnDepNpmTemplate.apply(source, {
      type: 'vuln-dep:npm',
      file: 'package-lock.json',
      package: 'lodash',
      version: '4.17.20',
    });
    const parsed = JSON.parse(mutated);
    expect(parsed.packages['node_modules/lodash']).toEqual({ version: '4.17.20' });
    expect(truth.bug_type).toBe('vuln-dep:npm:lodash@4.17.20');
    expect(truth.severity).toBe('critical');
    expect(truth.category).toContain('vulnerability');
    expect(truth.file).toBe('package-lock.json');
    // line_range points at the "version": line inside the new node_modules/lodash entry.
    expect(truth.line_range[0]).toBeGreaterThan(0);
    expect(truth.line_range[1]).toBeGreaterThanOrEqual(truth.line_range[0]);

    // Regression for PR #10 comment 3295026564. The truth line MUST point at
    // an actual "version": declaration. The previous code silently fell back
    // to the package-key line if the search loop didn't match, which would
    // anchor the truth at the wrong line and cause the CVE truth to score
    // as FN despite a correct scanner hit (scanner anchors at "version:").
    const truthLineContent = mutated.split('\n')[truth.line_range[0] - 1];
    expect(truthLineContent).toContain('"version":');
  });

  it('rejects a non-package-lock.json file', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{}', {
        type: 'vuln-dep:npm',
        file: 'src/foo.ts',
        package: 'lodash',
        version: '4.17.20',
      }),
    ).toThrow(/package-lock\.json/);
  });

  it('rejects malformed lockfile JSON', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{ bad json', {
        type: 'vuln-dep:npm',
        file: 'package-lock.json',
        package: 'lodash',
        version: '4.17.20',
      }),
    ).toThrow(/JSON/i);
  });

  it('rejects missing package or version', () => {
    expect(() =>
      vulnDepNpmTemplate.apply('{"packages": {"": {}}}', {
        type: 'vuln-dep:npm',
        file: 'package-lock.json',
      }),
    ).toThrow(/package.*version/i);
  });

  it('rejects a no-op plant when the same package@version is already pinned', () => {
    // Regression for PR #10 Codex P2 3295066582. If the planted version
    // matches what's already in before/, the mutation is a no-op,
    // synthesizeDiff drops the file, and the truth entry scores as a
    // guaranteed FN. Fail loud at plant time instead.
    const source = JSON.stringify(
      {
        name: 'test',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.20' }, // already pinned
        },
      },
      null,
      2,
    );
    expect(() =>
      vulnDepNpmTemplate.apply(source, {
        type: 'vuln-dep:npm',
        file: 'package-lock.json',
        package: 'lodash',
        version: '4.17.20', // same version as already pinned
      }),
    ).toThrow(/already pinned.*no-op/);
  });

  it('preserves resolved/integrity/other fields on a version re-pin', () => {
    // Regression for PR #10 dogfood IMPORTANT 3295239963. The previous code
    // wholesale-replaced the package entry, stripping `resolved`,
    // `integrity`, and any other fields. Real lockfiles carry those; the
    // mutated after/ should stay realistic.
    const source = JSON.stringify(
      {
        name: 'test',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/lodash': {
            version: '4.17.10', // about to be upgraded
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.10.tgz',
            integrity: 'sha512-OLD-SHA',
            engines: { node: '>=12' },
          },
        },
      },
      null,
      2,
    );
    const { mutated } = vulnDepNpmTemplate.apply(source, {
      type: 'vuln-dep:npm',
      file: 'package-lock.json',
      package: 'lodash',
      version: '4.17.20',
    });
    const parsed = JSON.parse(mutated);
    const entry = parsed.packages['node_modules/lodash'];
    expect(entry.version).toBe('4.17.20'); // new version
    // Sibling fields must survive the re-pin.
    expect(entry.resolved).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.10.tgz');
    expect(entry.integrity).toBe('sha512-OLD-SHA');
    expect(entry.engines).toEqual({ node: '>=12' });
  });

  it('accepts a re-pin to a different version of an already-present package', () => {
    // Companion to the no-op-rejection test: pinning lodash@4.17.20 when the
    // lockfile already has lodash@4.17.10 IS a real mutation (different
    // versions), so it should succeed and produce a meaningful diff.
    const source = JSON.stringify(
      {
        name: 'test',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.10' }, // different version
        },
      },
      null,
      2,
    );
    const { mutated, truth } = vulnDepNpmTemplate.apply(source, {
      type: 'vuln-dep:npm',
      file: 'package-lock.json',
      package: 'lodash',
      version: '4.17.20', // upgrade pin to vulnerable version
    });
    expect(mutated).toContain('"4.17.20"');
    expect(mutated).not.toContain('"4.17.10"');
    expect(truth.bug_type).toBe('vuln-dep:npm:lodash@4.17.20');
  });
});
