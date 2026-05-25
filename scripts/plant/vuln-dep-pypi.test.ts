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
