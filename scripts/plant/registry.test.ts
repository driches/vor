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

  it('returns each new (v1.1) template by type', () => {
    expect(getTemplate('secret:github-pat').type).toBe('secret:github-pat');
    expect(getTemplate('secret:pem-private-key').type).toBe('secret:pem-private-key');
    expect(getTemplate('path-traversal').type).toBe('path-traversal');
    expect(getTemplate('eval-user-input').type).toBe('eval-user-input');
    expect(getTemplate('vuln-dep:pypi').type).toBe('vuln-dep:pypi');
    expect(getTemplate('n-plus-one-query').type).toBe('n-plus-one-query');
    expect(getTemplate('off-by-one-loop').type).toBe('off-by-one-loop');
    expect(getTemplate('missing-null-check').type).toBe('missing-null-check');
    expect(getTemplate('sync-in-async-loop').type).toBe('sync-in-async-loop');
  });

  it('throws when given an unknown type, listing available ones', () => {
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/secret:aws-access-key/);
    expect(() => getTemplate('not-a-real-plant-type')).toThrow(/not-a-real-plant-type/);
  });

  it('lists exactly the v1.1 template types', () => {
    expect(listTemplateTypes().sort()).toEqual([
      'eval-user-input',
      'missing-null-check',
      'n-plus-one-query',
      'off-by-one-loop',
      'path-traversal',
      'secret:aws-access-key',
      'secret:github-pat',
      'secret:pem-private-key',
      'sql-injection',
      'sync-in-async-loop',
      'vuln-dep:npm',
      'vuln-dep:pypi',
    ]);
  });
});
