/**
 * Assemble the set of enabled scanners from a {@link SecurityConfig}.
 *
 * The orchestrator (Task 8) calls this once per review to turn the raw
 * config slice into the array of Scanner instances passed to
 * `runScanners()`. Two layers of opt-in apply:
 *
 *   - `config.enabled === false` short-circuits the whole pipeline — we
 *     return `[]` and no scanner is ever constructed.
 *   - Otherwise each scanner's per-slot `enabled` flag gates whether its
 *     factory runs. Both flags must be `true` for a scanner to participate.
 *
 * Factories are normally the real ones from the scanner modules in this
 * directory, but every slot accepts an override via
 * {@link BuildScannersOptions.scannerFactories}. The override is what tests
 * (and Task 8's orchestrator tests) use to inject mock scanners without
 * spinning up OSV clients or regex engines.
 *
 * Pass-throughs of config detail:
 *   - `secrets.include_generic_entropy` → factory option of same name.
 *   - `dependency_cve.osv_endpoint`     → builds a per-run {@link OsvClient}
 *     pointed at the override, threaded through to the dep-CVE factory.
 */
import type { Scanner } from './types.js';
import type { ScannerId } from '../types.js';
import type { SecurityConfig } from '../config/types.js';
import { createDependencyCveScanner } from './dependency-cve.js';
import { createSecretsScanner } from './secrets.js';
import { sastScannerStub } from './sast.js';
import { containerScannerStub } from './container.js';
import { createCoverageDeltaScanner } from './coverage-delta.js';
import { createOsvClient } from './osv-client.js';

/**
 * Overridable factory bag. Keys match scanner ids exactly so the override
 * surface stays explicit and discoverable. Each factory takes no args
 * because all the scanner-specific config it needs is already closed over
 * by the call site below.
 */
export interface BuildScannersOptions {
  scannerFactories?: Partial<Record<ScannerId, () => Scanner>>;
}

/**
 * Build the array of enabled Scanner instances in a deterministic order
 * (dependency-cve, secrets, sast, container-cve, coverage-delta). Order is
 * stable so the runner's perScanner array — and ultimately the review
 * summary — keeps a predictable shape across runs.
 *
 * Note: this function performs no I/O. The dependency-cve factory does lazy
 * construction of the OSV client internally, so even when osv_endpoint is
 * set we don't issue any network calls until `scan()` actually runs.
 */
export function buildEnabledScanners(
  config: SecurityConfig,
  options: BuildScannersOptions = {},
): Scanner[] {
  // Master switch — when the whole feature is off, return nothing so the
  // orchestrator can skip the scanner pipeline entirely.
  if (config.enabled === false) return [];

  const overrides = options.scannerFactories ?? {};
  const out: Scanner[] = [];

  // dependency-cve
  if (config.scanners.dependency_cve.enabled) {
    const factory: () => Scanner =
      overrides['dependency-cve'] ??
      (() => {
        const endpoint = config.scanners.dependency_cve.osv_endpoint;
        // Construct the OSV client only when an endpoint override is in
        // play; the dep-CVE scanner constructs a default client lazily on
        // first use otherwise, which avoids allocating a fetch wrapper for
        // PRs that never trigger the scanner.
        if (endpoint !== undefined && endpoint !== '') {
          return createDependencyCveScanner({
            osvClient: createOsvClient({ endpoint }),
          });
        }
        return createDependencyCveScanner();
      });
    out.push(factory());
  }

  // secrets
  if (config.scanners.secrets.enabled) {
    const factory: () => Scanner =
      overrides.secrets ??
      (() =>
        createSecretsScanner({
          includeGenericEntropy:
            config.scanners.secrets.include_generic_entropy === true,
        }));
    out.push(factory());
  }

  // sast (stub in v1) — only included when explicitly enabled so the slot
  // doesn't pollute the perScanner array with always-empty results.
  if (config.scanners.sast.enabled) {
    const factory: () => Scanner = overrides.sast ?? (() => sastScannerStub);
    out.push(factory());
  }

  // container-cve (stub in v1)
  if (config.scanners.container_cve.enabled) {
    const factory: () => Scanner =
      overrides['container-cve'] ?? (() => containerScannerStub);
    out.push(factory());
  }

  // coverage-delta (opt-in — see DEFAULT_CONFIG comment for the rationale).
  // Last in the order so any LLM-side dedup against AI test-gap comments
  // sees the higher-context findings first. Stable position lets the
  // perScanner array and review summary keep predictable shape.
  if (config.scanners.coverage_delta.enabled) {
    const factory: () => Scanner =
      overrides['coverage-delta'] ?? (() => createCoverageDeltaScanner());
    out.push(factory());
  }

  return out;
}
