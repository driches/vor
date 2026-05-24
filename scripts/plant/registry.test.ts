import { describe, expect, it } from 'vitest';
import { getTemplate, listTemplateTypes } from './registry.js';

describe('plant template registry', () => {
  it('returns the aws-access-key template by type', () => {
    const t = getTemplate('secret:aws-access-key');
    expect(t.type).toBe('secret:aws-access-key');
  });

  it('returns the sql-injection template by type', () => {
    expect(getTemplate('sql-injection').type).toBe('sql-injection');
  });

  it('returns the vuln-dep:npm template by type', () => {
    expect(getTemplate('vuln-dep:npm').type).toBe('vuln-dep:npm');
  });

  it('throws when given an unknown type, listing available ones', () => {
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/secret:aws-access-key/);
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/not-a-real-plant-type/);
  });

  it('lists exactly the v1 template types', () => {
    expect(listTemplateTypes().sort()).toEqual([
      'secret:aws-access-key',
      'sql-injection',
      'vuln-dep:npm',
    ]);
  });
});
