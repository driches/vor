import { describe, expect, it } from 'vitest';
import { canonicalizePackageName } from './canonicalize.js';

describe('canonicalizePackageName', () => {
  describe('PyPI (PEP 503)', () => {
    it('lowercases the name', () => {
      expect(canonicalizePackageName('Flask', 'PyPI')).toBe('flask');
    });

    it('collapses dots to hyphens', () => {
      expect(canonicalizePackageName('zope.interface', 'PyPI')).toBe('zope-interface');
    });

    it('collapses underscores to hyphens', () => {
      expect(canonicalizePackageName('zope_interface', 'PyPI')).toBe('zope-interface');
    });

    it('collapses runs of mixed separators to a single hyphen', () => {
      expect(canonicalizePackageName('zope._-_interface', 'PyPI')).toBe('zope-interface');
    });

    it('treats `.`, `_`, `-` as equivalent (cross-form match)', () => {
      const variants = [
        'zope.interface',
        'zope_interface',
        'zope-interface',
        'Zope.Interface',
        'ZOPE_INTERFACE',
      ];
      const canonical = variants.map((v) => canonicalizePackageName(v, 'PyPI'));
      expect(new Set(canonical).size).toBe(1);
      expect(canonical[0]).toBe('zope-interface');
    });
  });

  describe('npm', () => {
    it('lowercases the name', () => {
      expect(canonicalizePackageName('React', 'npm')).toBe('react');
    });

    it('does NOT collapse separators (npm names treat `.` and `_` literally)', () => {
      // npm allows `.` and `_` in names with distinct meaning, unlike PyPI.
      expect(canonicalizePackageName('a.b', 'npm')).toBe('a.b');
      expect(canonicalizePackageName('a_b', 'npm')).toBe('a_b');
    });
  });

  describe('other ecosystems', () => {
    it('returns the input verbatim for Maven', () => {
      expect(canonicalizePackageName('com.Example/Foo', 'Maven')).toBe('com.Example/Foo');
    });

    it('returns the input verbatim for an unknown ecosystem', () => {
      expect(canonicalizePackageName('Some-Name', 'Crates.io')).toBe('Some-Name');
    });
  });
});
