/**
 * HTTP client for OSV.dev — see https://google.github.io/osv.dev/api/.
 *
 * Used by the dependency-cve scanner to resolve lockfile entries to
 * vulnerability records. Two endpoints are exposed:
 *
 *   - `queryBatch`  → POST /v1/querybatch — bulk lookup of vuln IDs by
 *                     (ecosystem, name, version). Returns a list of ID stubs
 *                     per query slot.
 *   - `getVuln`     → GET  /v1/vulns/{id} — full record for one vulnerability
 *                     (severity, ranges, aliases, etc).
 *
 * Resiliency:
 *   - Network failures and HTTP 5xx are retried with exponential backoff
 *     (default 500/1500/4500 ms). 4xx responses are NOT retried — they
 *     indicate a malformed request and won't be cured by waiting.
 *   - Each request has an independent timeout via AbortController.
 *   - `queryBatch` automatically splits inputs >100 into multiple requests so
 *     callers don't need to chunk.
 *
 * Error contract: after all retries are exhausted (or on any non-retryable
 * HTTP status), throw {@link OsvClientError} with a descriptive message. The
 * caller (the dependency-cve scanner) is expected to catch this and surface it
 * as a non-fatal {@link import('./types.js').ScanError}.
 */

const DEFAULT_ENDPOINT = 'https://api.osv.dev';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
/** OSV docs cap individual batches; 100 is a safe, conservative size. */
const QUERY_BATCH_LIMIT = 100;
/** Backoff schedule: attempt N waits BASE * 3^N ms. → 500, 1500, 4500, ... */
const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 3;

export interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
}

/** One element of the response's `results` array. Matches the OSV.dev v1 schema. */
export interface OsvBatchHit {
  vulns?: Array<{ id: string; modified: string }>;
}

export interface OsvBatchResponse {
  results: OsvBatchHit[];
}

/** Full vulnerability record from /v1/vulns/{id}. */
export interface OsvVuln {
  id: string;
  /** Includes CVE-XXX, GHSA-XXX, etc. */
  aliases?: string[];
  summary?: string;
  details?: string;
  /** type='CVSS_V3', score=vector string. */
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: Array<{
      type: string;
      events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
    }>;
  }>;
  /** GHSA severity if available (LOW/MODERATE/HIGH/CRITICAL). */
  database_specific?: { severity?: string };
}

/**
 * Optional per-call options accepted by every OsvClient method. The
 * `signal` lets the caller cancel an in-flight HTTP exchange (and all
 * pending retries) when an external deadline elapses — e.g. the scanner
 * runner's per-scanner timeout. The client combines `opts.signal` with its
 * own per-request timeout so either firing aborts the underlying fetch.
 */
export interface OsvRequestOptions {
  signal?: AbortSignal;
}

export interface OsvClient {
  queryBatch(queries: OsvQuery[], opts?: OsvRequestOptions): Promise<OsvBatchResponse>;
  getVuln(id: string, opts?: OsvRequestOptions): Promise<OsvVuln>;
}

export interface OsvClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Dependency-injection point for tests; defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Thrown when an OSV request fails after all retries, or on a non-retryable
 * HTTP status (4xx). The message is human-readable; callers should NOT parse
 * it but may surface it verbatim in a scanner error.
 */
export class OsvClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    // ES2022 Error supports `cause` natively via the options bag; no need to
    // assign it manually after super().
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OsvClientError';
  }
}

interface ResolvedOptions {
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: typeof fetch;
}

function resolveOptions(opts?: OsvClientOptions): ResolvedOptions {
  return {
    endpoint: (opts?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: opts?.maxRetries ?? DEFAULT_MAX_RETRIES,
    fetch: opts?.fetch ?? fetch,
  };
}

/**
 * Sleep with cancellation. Resolves when the timer fires OR when the optional
 * `signal` aborts (in which case the returned promise REJECTS with an
 * AbortError so the caller breaks out of the backoff loop instead of waiting
 * the full delay).
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 5xx and network failures are transient; anything else is the caller's fault
 * and won't recover by waiting. (404 in particular MUST NOT retry — it's a
 * legitimate "this CVE id does not exist".)
 */
function shouldRetryStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * True if `err` was caused by the caller's AbortSignal firing. We treat
 * these as non-retryable: the scanner runner has already given up on this
 * work, so retrying would only burn time/network budget the deadline says
 * is gone. Detected via the AbortError name on the underlying `cause`
 * (set by `fetchOnce` when the request's AbortController fires).
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof OsvClientError)) return false;
  const cause = err.cause as { name?: string } | undefined;
  return cause?.name === 'AbortError';
}

/**
 * Run `requestFn` with the retry policy. `requestFn` MUST throw on a 4xx (we
 * don't have visibility into the response here) so it's structured as an
 * async function returning the parsed body and throwing typed errors
 * otherwise.
 *
 * Honors `signal` (the caller-supplied cancellation): if it fires between
 * attempts we exit the loop immediately instead of waiting out the backoff
 * and trying again. Also short-circuits when the failure ITSELF was caused
 * by the abort (e.g. `fetchOnce` rejected because the signal fired during
 * the request).
 */
async function withRetries<T>(
  requestFn: () => Promise<T>,
  maxRetries: number,
  describe: string,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new OsvClientError(`${describe} aborted before attempt ${attempt + 1}`, undefined, {
        cause: lastErr ?? new DOMException('Aborted', 'AbortError'),
      });
    }
    try {
      return await requestFn();
    } catch (err) {
      lastErr = err;
      // Non-retryable client errors short-circuit.
      if (err instanceof OsvClientError && err.status != null && !shouldRetryStatus(err.status)) {
        throw err;
      }
      // The caller cancelled us mid-request — don't retry, propagate.
      if (isAbortError(err) || signal?.aborted) {
        throw err instanceof OsvClientError
          ? err
          : new OsvClientError(`${describe} aborted`, undefined, { cause: err });
      }
      if (attempt === maxRetries) break;
      const delay = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt);
      try {
        await sleep(delay, signal);
      } catch {
        // Abort fired during backoff sleep — propagate the original error
        // (or a wrapped abort error) without further retries.
        throw err instanceof OsvClientError
          ? err
          : new OsvClientError(`${describe} aborted during backoff`, undefined, { cause: err });
      }
    }
  }
  if (lastErr instanceof OsvClientError) throw lastErr;
  throw new OsvClientError(
    `${describe} failed after ${maxRetries + 1} attempts: ${(lastErr as Error)?.message ?? lastErr}`,
    undefined,
    { cause: lastErr },
  );
}

/**
 * Execute a single HTTP request with a timeout via AbortController. The
 * timeout is cleared on any completion (success OR error) so we never leak
 * a pending timer. On 4xx we throw an OsvClientError with the status so the
 * retry layer can short-circuit; on 5xx we also throw with status so retry
 * keeps going.
 */
async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  describe: string,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  // Track which side of the abort fired so the error message is accurate.
  // - `internalTimedOut`: the timeout callback below ran, meaning the request
  //   exceeded `timeoutMs`.
  // - external abort: caught via `externalSignal.aborted` in the catch block.
  // Both can be true if the external signal fires AFTER the internal timer
  // (rare but possible) — in that case we report internal timeout because
  // chronologically that's what aborted the request.
  let internalTimedOut = false;
  const timer = setTimeout(() => {
    internalTimedOut = true;
    controller.abort();
  }, timeoutMs);
  // Combine internal timeout signal with caller-supplied signal (if any).
  // Either firing aborts the fetch — prefer native AbortSignal.any when
  // available (Node 20.3+); fall back to a manual relay otherwise.
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // Drain the body so the underlying socket can be reused / released.
      let bodyExcerpt = '';
      try {
        bodyExcerpt = (await res.text()).slice(0, 200);
      } catch {
        // Best-effort; body read failure is not interesting.
      }
      throw new OsvClientError(
        `${describe} returned HTTP ${res.status}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`,
        res.status,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof OsvClientError) throw err;
    // AbortError → distinguish internal-timeout vs external-cancellation so
    // the operator sees an accurate cause. Without this, every abort was
    // labelled "timed out", which is wrong when the caller explicitly
    // cancelled (e.g. a parent AbortController firing from a higher-level
    // deadline). Tests can assert on the precise phrasing.
    if ((err as Error)?.name === 'AbortError') {
      let message: string;
      if (internalTimedOut) {
        message = `${describe} timed out after ${timeoutMs}ms`;
      } else if (externalSignal?.aborted) {
        message = `${describe} aborted by caller`;
      } else {
        message = `${describe} aborted (internal timeout or external signal)`;
      }
      throw new OsvClientError(message, undefined, { cause: err });
    }
    throw new OsvClientError(
      `${describe} network error: ${(err as Error)?.message ?? err}`,
      undefined,
      {
        cause: err,
      },
    );
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function createOsvClient(opts?: OsvClientOptions): OsvClient {
  const cfg = resolveOptions(opts);

  async function queryBatchChunk(
    queries: OsvQuery[],
    signal?: AbortSignal,
  ): Promise<OsvBatchResponse> {
    return withRetries(
      async () => {
        const res = await fetchOnce(
          cfg.fetch,
          `${cfg.endpoint}/v1/querybatch`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ queries }),
          },
          cfg.timeoutMs,
          'OSV querybatch',
          signal,
        );
        return (await res.json()) as OsvBatchResponse;
      },
      cfg.maxRetries,
      'OSV querybatch',
      signal,
    );
  }

  return {
    async queryBatch(
      queries: OsvQuery[],
      opts?: OsvRequestOptions,
    ): Promise<OsvBatchResponse> {
      if (queries.length === 0) return { results: [] };

      const chunks = chunk(queries, QUERY_BATCH_LIMIT);
      // Run chunks sequentially. Parallelism here would only help when the
      // input is several hundred deps; in that regime we're already an
      // outlier and the OSV server prefers we serialize.
      const aggregated: OsvBatchHit[] = [];
      for (const part of chunks) {
        const resp = await queryBatchChunk(part, opts?.signal);
        aggregated.push(...resp.results);
      }
      return { results: aggregated };
    },

    async getVuln(id: string, opts?: OsvRequestOptions): Promise<OsvVuln> {
      return withRetries(
        async () => {
          const res = await fetchOnce(
            cfg.fetch,
            `${cfg.endpoint}/v1/vulns/${encodeURIComponent(id)}`,
            { method: 'GET' },
            cfg.timeoutMs,
            `OSV getVuln(${id})`,
            opts?.signal,
          );
          return (await res.json()) as OsvVuln;
        },
        cfg.maxRetries,
        `OSV getVuln(${id})`,
        opts?.signal,
      );
    },
  };
}
