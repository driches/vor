import { describe, expect, it } from 'vitest';
import {
  extractContext,
  globSpecificity,
  isTestFile,
  matchesAnyGlob,
  matchesGlob,
  normalizePath,
} from './glob.js';

describe('normalizePath', () => {
  it('normalizes slashes and leading dots', () => {
    expect(normalizePath('./src\\domain//order.ts/')).toBe('src/domain/order.ts');
    expect(normalizePath('/src/app/')).toBe('src/app');
  });
});

describe('matchesGlob', () => {
  it('supports **, *, ?, and brace expansion', () => {
    expect(matchesGlob('src/domain/order.ts', '**/domain/**')).toBe(true);
    expect(matchesGlob('domain/order.ts', '**/domain/**')).toBe(true);
    expect(matchesGlob('src/contexts/billing/domain/order.ts', '**/domain/**')).toBe(true);
    expect(matchesGlob('src/domain-helper/order.ts', '**/domain/**')).toBe(false);
    expect(matchesGlob('src/contexts/billing/index.ts', 'index.{ts,tsx,js}')).toBe(false);
    expect(matchesGlob('index.ts', 'index.{ts,tsx,js}')).toBe(true);
    expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true);
    expect(matchesGlob('a12.ts', 'a?.ts')).toBe(false);
    expect(matchesGlob('src/domain-helper/order.ts', 'src/domain**')).toBe(false);
    expect(matchesGlob('src/domain.ts', 'src/domain**')).toBe(true);
    expect(matchesGlob('src/a/b-helper/order.ts', 'src/**helper/order.ts')).toBe(false);
    expect(matchesGlob('src/my-helper/order.ts', 'src/**helper/order.ts')).toBe(true);
    expect(matchesGlob('src/domain/a/b.ts', 'src/domain/**')).toBe(true);
  });

  it('matchesAnyGlob checks a list', () => {
    expect(matchesAnyGlob('src/infra/db.ts', ['**/domain/**', '**/infra/**'])).toBe(true);
    expect(matchesAnyGlob('src/ui/page.ts', ['**/domain/**', '**/infra/**'])).toBe(false);
    expect(matchesAnyGlob('src/ui/page.ts', [])).toBe(false);
  });
});

describe('globSpecificity', () => {
  it('ranks nested layer globs above parent globs', () => {
    expect(globSpecificity('**/adapters/in/**')).toBeGreaterThan(globSpecificity('**/adapters/**'));
    expect(globSpecificity('**/application/ports/**')).toBeGreaterThan(
      globSpecificity('**/application/**'),
    );
  });
});

describe('extractContext', () => {
  it('extracts context name, root, and relative path for direct patterns', () => {
    expect(extractContext('src/contexts/billing/domain/invoice.ts', 'src/contexts/*')).toEqual({
      context: 'billing',
      contextRoot: 'src/contexts/billing',
      relativePath: 'domain/invoice.ts',
    });
    expect(extractContext('src/contexts/billing', 'src/contexts/*')).toEqual({
      context: 'billing',
      contextRoot: 'src/contexts/billing',
      relativePath: '',
    });
    expect(extractContext('src/shared/money.ts', 'src/contexts/*')).toBeNull();
  });

  it('handles **/ wildcard prefixes and binds to outermost context', () => {
    expect(
      extractContext('services/api/src/modules/orders/modules/sub.ts', '**/modules/*'),
    ).toEqual({
      context: 'orders',
      contextRoot: 'services/api/src/modules/orders',
      relativePath: 'modules/sub.ts',
    });
  });

  it('handles patterns with a trailing suffix segment', () => {
    expect(extractContext('packages/auth/src/public/api.ts', 'packages/*/src')).toEqual({
      context: 'auth',
      contextRoot: 'packages/auth/src',
      relativePath: 'public/api.ts',
    });
    expect(extractContext('packages/auth/package.json', 'packages/*/src')).toBeNull();
  });

  it('normalizes trailing /** with or without an explicit * segment', () => {
    expect(extractContext('src/contexts/billing/domain/invoice.ts', 'src/contexts/**')).toEqual({
      context: 'billing',
      contextRoot: 'src/contexts/billing',
      relativePath: 'domain/invoice.ts',
    });
    expect(extractContext('src/contexts/billing/domain/invoice.ts', 'src/contexts/*/**')).toEqual({
      context: 'billing',
      contextRoot: 'src/contexts/billing',
      relativePath: 'domain/invoice.ts',
    });
    expect(
      extractContext('services/api/src/contexts/orders/internal/db.ts', '**/contexts/**'),
    ).toEqual({
      context: 'orders',
      contextRoot: 'services/api/src/contexts/orders',
      relativePath: 'internal/db.ts',
    });
    expect(extractContext('packages/auth/src/public/api.ts', 'packages/*/src/**')).toEqual({
      context: 'auth',
      contextRoot: 'packages/auth/src',
      relativePath: 'public/api.ts',
    });
    expect(extractContext('src/contexts/billing/invoice.ts', 'src/contexts')).toBeNull();
  });
});

describe('isTestFile', () => {
  it('detects tests across supported languages', () => {
    expect(isTestFile('src/domain/order.test.ts')).toBe(true);
    expect(isTestFile('src/domain/order.spec.tsx')).toBe(true);
    expect(isTestFile('tests/order_test.go')).toBe(true);
    expect(isTestFile('internal/domain/order_test.go')).toBe(true);
    expect(isTestFile('app/test_order.py')).toBe(true);
    expect(isTestFile('test/domain/order_test.dart')).toBe(true);
    expect(isTestFile('src/test/java/com/acme/OrderTest.java')).toBe(true);
    expect(isTestFile('Tests/OrderTests.cs')).toBe(true);
    expect(isTestFile('src/domain/order.ts')).toBe(false);
    expect(isTestFile('src/domain/testimony.ts')).toBe(false);
  });
});
