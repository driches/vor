/**
 * Error-isolated parallel runner for the configured scanner set.
 *
 * Per-PR life cycle (called by the orchestrator in Task 8):
 *
 *   1. For each {@link Scanner}, in parallel via `Promise.all`:
 *      a. Cheap pre-check via `applies(deps.changedFiles)`. If the scanner
 *         declines, synthesize an {@link emptyResult} and skip `scan()`.
 *      b. Otherwise race `scanner.scan(deps)` against a `setTimeout`-driven
 *         timeout (default 60s). On timeout the synthetic result records a
 *         non-fatal {@link ScanError} naming the scanner so the orchestrator
 *         can surface "scanner X timed out" in the review summary.
 *      c. Wrap the whole step in try/catch. Anything thrown from `applies`,
 *         the race plumbing, or the scanner itself degrades to the same
 *         shaped error result. The runner NEVER lets a scanner crash the
 *         review.
 *   2. After every scanner settles, flatten findings, run cross-scanner
 *      dedup, and return both the deduped union AND the raw per-scanner
 *      results (the orchestrator needs the latter for metrics + errors).
 *
 * Timer hygiene: every scanner that completes BEFORE its timeout clears the
 * timer (`clearTimeout(timer)`) so Node doesn't keep the process alive
 * waiting on a phantom abort. Tests cover both the timeout-fires and the
 * timeout-cleared paths.
 */
import type {
  ScanError,
  ScanFinding,
  ScanResult,
  Scanner,
  ScannerDeps,
} from './types.js';
import type { ScannerId } from '../types.js';
import { emptyResult } from './types.js';
import { dedupAcrossScanners } from './dedup.js';
import { logger as defaultLogger } from '../util/logger.js';

/**
 * Structural type for the logger we accept via DI. Mirrors the public
 * surface of `src/util/logger.ts#logger` so tests can stub it without
 * dragging in `@actions/core`. The narrower shape (only the methods this
 * runner uses) keeps the dependency contract honest.
 */
export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

/** Default per-scanner timeout. 60s is well over the 95th-percentile OSV
 *  batch latency we've seen in practice, but short enough that a wedged
 *  network call doesn't deadline the whole review. */
const DEFAULT_PER_SCANNER_TIMEOUT_MS = 60_000;

export interface RunScannersResult {
  /** Cross-scanner deduped findings (Pass 1 only — Pass 2 happens later, once
   *  the AI comments are known). */
  findings: ScanFinding[];
  /** Per-scanner raw results, preserving input order. Includes any scanner
   *  that opted out via `applies()`, with an empty findings array. */
  perScanner: ScanResult[];
}

export interface RunScannersOptions {
  perScannerTimeoutMs?: number;
  logger?: Logger;
}

interface ResolvedOptions {
  perScannerTimeoutMs: number;
  logger: Logger;
}

function resolveOptions(opts?: RunScannersOptions): ResolvedOptions {
  return {
    perScannerTimeoutMs: opts?.perScannerTimeoutMs ?? DEFAULT_PER_SCANNER_TIMEOUT_MS,
    logger: opts?.logger ?? defaultLogger,
  };
}

/**
 * Race a `scan()` promise against a setTimeout-driven timeout. The timer
 * handle is cleared on EITHER outcome so we don't keep the event loop alive
 * for a scanner that finished quickly.
 *
 * On timeout we reject with a typed `Error` whose message includes the
 * scanner id so the caller can attribute the failure. The losing branch
 * (scanner that completes AFTER the timer fired) is silently ignored — we
 * already lost the race and there's no caller waiting on it.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  scannerId: ScannerId,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Capture the timer handle so success can clear it.
    const timer = setTimeout(() => {
      reject(new Error(`scanner ${scannerId} timed out`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Build an empty result with a single non-fatal error. Used as the
 * recovery shape when a scanner throws or times out.
 */
function errorResult(
  scannerId: ScannerId,
  started: number,
  errorMessage: string,
): ScanResult {
  const base = emptyResult(scannerId, Date.now() - started);
  const err: ScanError = { message: errorMessage, fatal: false };
  return { ...base, errors: [err] };
}

/**
 * Run a single scanner end-to-end. Never throws — every failure mode
 * (applies-throws, scan-throws, timeout) is converted into a synthetic
 * {@link ScanResult} carrying a non-fatal {@link ScanError}.
 */
async function runOne(
  scanner: Scanner,
  deps: ScannerDeps,
  opts: ResolvedOptions,
): Promise<ScanResult> {
  const started = Date.now();
  // Pre-check first. If applies() itself throws we still degrade gracefully.
  let willScan: boolean;
  try {
    willScan = scanner.applies(deps.changedFiles);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    void opts.logger.warn(`scanner ${scanner.id} applies() threw: ${message}`);
    return errorResult(scanner.id, started, `applies() threw: ${message}`);
  }
  if (!willScan) {
    return emptyResult(scanner.id, Date.now() - started);
  }

  try {
    const result = await withTimeout(
      scanner.scan(deps),
      opts.perScannerTimeoutMs,
      scanner.id,
    );
    return result;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    void opts.logger.warn(`scanner ${scanner.id} failed: ${message}`);
    return errorResult(scanner.id, started, message);
  }
}

/**
 * Public entry point. Run every scanner in parallel, collect their results,
 * cross-scanner dedup the union, and return both views.
 *
 * Input order is preserved in `perScanner` — `Promise.all` preserves
 * positional order regardless of resolution order. The deduped `findings`
 * array follows the input order too: dedup is stable on first-appearance.
 */
export async function runScanners(
  scanners: readonly Scanner[],
  deps: ScannerDeps,
  options?: RunScannersOptions,
): Promise<RunScannersResult> {
  const opts = resolveOptions(options);

  const perScanner = await Promise.all(
    scanners.map((s) => runOne(s, deps, opts)),
  );

  const allFindings: ScanFinding[] = [];
  for (const r of perScanner) {
    if (r.findings.length > 0) allFindings.push(...r.findings);
  }
  const findings = dedupAcrossScanners(allFindings);

  return { findings, perScanner };
}
