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
});
