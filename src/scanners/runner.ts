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
import type { ScanError, ScanFinding, ScanResult, Scanner, ScannerDeps } from './types.js';
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
 * Build an empty result with a single non-fatal error. Used as the
 * recovery shape when a scanner throws or times out.
 */
function errorResult(scannerId: ScannerId, started: number, errorMessage: string): ScanResult {
  const base = emptyResult(scannerId, Date.now() - started);
  const err: ScanError = { message: errorMessage, fatal: false };
  return { ...base, errors: [err] };
}

/**
 * Combine two AbortSignals into one that aborts whenever either input does.
 * Prefer the platform's native `AbortSignal.any` when available (Node 20.3+),
 * fall back to a manual relay on older runtimes (and to a wrapper that
 * forwards parent.aborted state at construction time). Returned signal is
 * detached from both inputs once aborted — no listener leaks even if either
 * input outlives the request.
 */
function anySignal(parent: AbortSignal, child: AbortSignal): AbortSignal {
  if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
      parent,
      child,
    ]);
  }
  // Fallback: relay aborts manually.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', onAbort, { once: true });
  if (child.aborted) controller.abort();
  else child.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * Run a single scanner end-to-end. Never throws — every failure mode
 * (applies-throws, scan-throws, timeout) is converted into a synthetic
 * {@link ScanResult} carrying a non-fatal {@link ScanError}.
 *
 * Cancellation: an AbortController is created per scan and `setTimeout`-
 * scheduled to abort after the per-scanner deadline. The controller's
 * signal is OR-ed (via {@link anySignal}) with whatever signal the caller
 * supplied in `deps.signal` and threaded into `deps.signal` for the scanner
 * to plumb into its network calls. When the deadline fires, in-flight
 * fetches reject with AbortError rather than continuing as detached tasks.
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

  const timeoutController = new AbortController();
  // Scanner-specific override wins over the runner-wide default. sast
  // declares a longer budget because it bundles semgrep, which downloads
  // rules and scans cross-language and can take >60s on big repos.
  const effectiveTimeoutMs = scanner.timeoutMs ?? opts.perScannerTimeoutMs;
  const timer = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
  const combinedSignal = anySignal(deps.signal, timeoutController.signal);
  const scopedDeps: ScannerDeps = { ...deps, signal: combinedSignal };
  // Belt-and-suspenders: a cooperative scanner will reject in-flight network
  // calls when `combinedSignal` aborts. A buggy or non-network scanner that
  // ignores its signal would hang us forever — race the scan against the
  // signal so we always unblock at the deadline. The losing branch can
  // still run to completion in the background; we just don't wait on it.
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (combinedSignal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    combinedSignal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });
  // Suppress unhandled-rejection warnings when the scanner wins the race.
  // `Promise.race` only propagates the FIRST settled branch — if the scanner
  // resolves first, the later abort still rejects this promise, but no one
  // is awaiting it. In Node 20 that fires an `unhandledRejection` warning
  // (and in tests appears as test-suite noise). This .catch attaches a
  // listener so the rejection is "handled" without changing race semantics:
  // the race below still receives whichever branch settles first.
  abortPromise.catch(() => {});
  try {
    return await Promise.race([scanner.scan(scopedDeps), abortPromise]);
  } catch (err) {
    // Distinguish "we aborted due to our own timeout" from "scanner threw
    // for some other reason." The latter still gets reported as a failure,
    // but the message format is different so the run summary can attribute
    // correctly.
    if (timeoutController.signal.aborted) {
      const message = `scanner ${scanner.id} timed out after ${effectiveTimeoutMs}ms`;
      void opts.logger.warn(message);
      return errorResult(scanner.id, started, message);
    }
    const message = (err as Error)?.message ?? String(err);
    void opts.logger.warn(`scanner ${scanner.id} failed: ${message}`);
    return errorResult(scanner.id, started, message);
  } finally {
    clearTimeout(timer);
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

  const perScanner = await Promise.all(scanners.map((s) => runOne(s, deps, opts)));

  const allFindings: ScanFinding[] = [];
  for (const r of perScanner) {
    if (r.findings.length > 0) allFindings.push(...r.findings);
  }
  const findings = dedupAcrossScanners(allFindings);

  return { findings, perScanner };
}
