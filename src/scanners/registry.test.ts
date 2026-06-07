/**
 * Tests for the scanner registry — config → Scanner[] assembly.
 *
 * The registry's contract is small but load-bearing:
 *   - honor the top-level `security.enabled` switch,
 *   - honor each per-scanner `enabled` switch,
 *   - thread scanner-specific config (osv_endpoint, include_generic_entropy)
 *     into the corresponding factory,
 *   - allow factory overrides for testing.
 *
 * We use vi.mock to substitute the real scanner factories with spies for
 * the threading tests, avoiding actual OSV client construction or regex
 * compilation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SecurityConfig } from '../config/types.js';
import { emptyResult } from './types.js';
import type { Scanner } from './types.js';

// vi.mock hoists, so we declare module mocks BEFORE importing the registry.
// We mock createOsvClient + the two real factories so we can assert how
// they were called by the registry. The stub modules don't need mocking —
// they're exported singletons.
const createDependencyCveScannerSpy = vi.fn();
const createSecretsScannerSpy = vi.fn();
const createOsvClientSpy = vi.fn();

vi.mock('./dependency-cve.js', () => ({
  createDependencyCveScanner: (...args: unknown[]) => {
    createDependencyCveScannerSpy(...args);
    return makeFakeScanner('dependency-cve');
  },
}));

vi.mock('./secrets.js', () => ({
  createSecretsScanner: (...args: unknown[]) => {
    createSecretsScannerSpy(...args);
    return makeFakeScanner('secrets');
  },
}));

vi.mock('./osv-client.js', () => ({
  createOsvClient: (...args: unknown[]) => {
    createOsvClientSpy(...args);
    return {
      queryBatch: vi.fn(),
      getVuln: vi.fn(),
    };
  },
}));

// Now the import — vi.mock has already swapped the module graph.
import { buildEnabledScanners } from './registry.js';

function makeFakeScanner(id: Scanner['id']): Scanner {
  return {
    id,
    applies: () => false,
    scan: async () => emptyResult(id),
  };
}

function makeConfig(over: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    enabled: true,
    ignore_file: '.vor/security-ignore.yml',
    scanners: {
      dependency_cve: { enabled: true },
      secrets: { enabled: true, include_generic_entropy: false },
      sast: { enabled: false },
      container_cve: { enabled: false },
      coverage_delta: { enabled: false },
      debris: { enabled: false },
      migration_safety: { enabled: false },
      dependency_hygiene: { enabled: false },
      image_ocr: { enabled: false },
    },
    cache: { enabled: true },
    persistence: { enabled: false },
    ...over,
  };
}

beforeEach(() => {
  createDependencyCveScannerSpy.mockClear();
  createSecretsScannerSpy.mockClear();
  createOsvClientSpy.mockClear();
});

// -----------------------------------------------------------------
// Default config
// -----------------------------------------------------------------

describe('buildEnabledScanners — default config', () => {
  it('returns the two enabled scanners (dependency-cve, secrets) in stable order', () => {
    const out = buildEnabledScanners(makeConfig());
    expect(out.map((s) => s.id)).toEqual(['dependency-cve', 'secrets']);
  });

  it('does not call createOsvClient when osv_endpoint is unset (default endpoint is lazy)', () => {
    buildEnabledScanners(makeConfig());
    expect(createOsvClientSpy).not.toHaveBeenCalled();
  });

  it('registers image-ocr (last) only when enabled', () => {
    expect(buildEnabledScanners(makeConfig()).map((s) => s.id)).not.toContain('image-ocr');
    const out = buildEnabledScanners(
      makeConfig({
        scanners: {
          dependency_cve: { enabled: false },
          secrets: { enabled: false, include_generic_entropy: false },
          sast: { enabled: false },
          container_cve: { enabled: false },
          coverage_delta: { enabled: false },
          debris: { enabled: false },
          migration_safety: { enabled: false },
          dependency_hygiene: { enabled: false },
          image_ocr: { enabled: true },
        },
      }),
    );
    expect(out.map((s) => s.id)).toEqual(['image-ocr']);
  });
});

// -----------------------------------------------------------------
// Top-level kill switch
// -----------------------------------------------------------------

describe('buildEnabledScanners — security.enabled=false', () => {
  it('returns an empty array regardless of per-scanner flags', () => {
    const out = buildEnabledScanners(
      makeConfig({
        enabled: false,
        scanners: {
          dependency_cve: { enabled: true },
          secrets: { enabled: true, include_generic_entropy: true },
          sast: { enabled: true },
          container_cve: { enabled: true },
          coverage_delta: { enabled: true },
          debris: { enabled: true },
          migration_safety: { enabled: true },
          dependency_hygiene: { enabled: true },
          image_ocr: { enabled: false },
        },
      }),
    );
    expect(out).toEqual([]);
    expect(createDependencyCveScannerSpy).not.toHaveBeenCalled();
    expect(createSecretsScannerSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Per-scanner disable
// -----------------------------------------------------------------

describe('buildEnabledScanners — all scanners disabled individually', () => {
  it('returns an empty array', () => {
    const out = buildEnabledScanners(
      makeConfig({
        scanners: {
          dependency_cve: { enabled: false },
          secrets: { enabled: false, include_generic_entropy: false },
          sast: { enabled: false },
          container_cve: { enabled: false },
          coverage_delta: { enabled: false },
          debris: { enabled: false },
          migration_safety: { enabled: false },
          dependency_hygiene: { enabled: false },
          image_ocr: { enabled: false },
        },
      }),
    );
    expect(out).toEqual([]);
    expect(createDependencyCveScannerSpy).not.toHaveBeenCalled();
    expect(createSecretsScannerSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// Secrets generic-entropy flag is threaded through
// -----------------------------------------------------------------

describe('buildEnabledScanners — secrets.include_generic_entropy threading', () => {
  it('passes includeGenericEntropy=true when the config flag is true', () => {
    buildEnabledScanners(
      makeConfig({
        scanners: {
          dependency_cve: { enabled: false },
          secrets: { enabled: true, include_generic_entropy: true },
          sast: { enabled: false },
          container_cve: { enabled: false },
          coverage_delta: { enabled: false },
          debris: { enabled: false },
          migration_safety: { enabled: false },
          dependency_hygiene: { enabled: false },
          image_ocr: { enabled: false },
        },
      }),
    );
    expect(createSecretsScannerSpy).toHaveBeenCalledTimes(1);
    expect(createSecretsScannerSpy).toHaveBeenCalledWith({ includeGenericEntropy: true });
  });

  it('passes includeGenericEntropy=false when the config flag is false', () => {
    buildEnabledScanners(makeConfig());
    expect(createSecretsScannerSpy).toHaveBeenCalledTimes(1);
    expect(createSecretsScannerSpy).toHaveBeenCalledWith({ includeGenericEntropy: false });
  });
});

// -----------------------------------------------------------------
// dependency-cve osv_endpoint threading
// -----------------------------------------------------------------

describe('buildEnabledScanners — dependency_cve.osv_endpoint threading', () => {
  it('constructs an OSV client with the override endpoint and threads it into the factory', () => {
    buildEnabledScanners(
      makeConfig({
        scanners: {
          dependency_cve: { enabled: true, osv_endpoint: 'https://osv.example.com' },
          secrets: { enabled: false, include_generic_entropy: false },
          sast: { enabled: false },
          container_cve: { enabled: false },
          coverage_delta: { enabled: false },
          debris: { enabled: false },
          migration_safety: { enabled: false },
          dependency_hygiene: { enabled: false },
          image_ocr: { enabled: false },
        },
      }),
    );
    expect(createOsvClientSpy).toHaveBeenCalledWith({ endpoint: 'https://osv.example.com' });
    expect(createDependencyCveScannerSpy).toHaveBeenCalledTimes(1);
    const arg = createDependencyCveScannerSpy.mock.calls[0]![0] as { osvClient?: unknown };
    expect(arg).toBeDefined();
    expect(arg.osvClient).toBeDefined();
  });
});

// -----------------------------------------------------------------
// Factory overrides
// -----------------------------------------------------------------

describe('buildEnabledScanners — factory overrides', () => {
  it('uses an override factory in place of the default when supplied', () => {
    const customScanner = makeFakeScanner('secrets');
    const overrideFactory = vi.fn(() => customScanner);

    const out = buildEnabledScanners(makeConfig(), {
      scannerFactories: { secrets: overrideFactory },
    });

    expect(overrideFactory).toHaveBeenCalledTimes(1);
    // The default secrets factory was NOT called because the override won.
    expect(createSecretsScannerSpy).not.toHaveBeenCalled();
    // The returned scanner array includes the overridden secrets instance.
    expect(out).toContain(customScanner);
  });

  it('allows overriding every scanner slot, including the disabled-by-default stubs', () => {
    const fakeSast = makeFakeScanner('sast');
    const fakeContainer = makeFakeScanner('container-cve');
    const sastFactory = vi.fn(() => fakeSast);
    const containerFactory = vi.fn(() => fakeContainer);

    const out = buildEnabledScanners(
      makeConfig({
        scanners: {
          dependency_cve: { enabled: false },
          secrets: { enabled: false, include_generic_entropy: false },
          sast: { enabled: true },
          container_cve: { enabled: true },
          coverage_delta: { enabled: false },
          debris: { enabled: false },
          migration_safety: { enabled: false },
          dependency_hygiene: { enabled: false },
          image_ocr: { enabled: false },
        },
      }),
      {
        scannerFactories: {
          sast: sastFactory,
          'container-cve': containerFactory,
        },
      },
    );

    expect(sastFactory).toHaveBeenCalledTimes(1);
    expect(containerFactory).toHaveBeenCalledTimes(1);
    expect(out).toEqual([fakeSast, fakeContainer]);
  });
});
