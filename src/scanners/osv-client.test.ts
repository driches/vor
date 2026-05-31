import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOsvClient,
  OsvClientError,
  type OsvBatchResponse,
  type OsvVuln,
} from './osv-client.js';

/**
 * Build a minimal Response stub that satisfies the bits of the WHATWG Response
 * interface our client touches: `ok`, `status`, `json()`, `text()`.
 */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, text = ''): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createOsvClient.queryBatch', () => {
  it('returns 2 results for 2 queries via a single POST', async () => {
    const body: OsvBatchResponse = {
      results: [
        { vulns: [{ id: 'OSV-1', modified: '2025-01-01T00:00:00Z' }] },
        { vulns: [{ id: 'OSV-2', modified: '2025-01-02T00:00:00Z' }] },
      ],
    };
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createOsvClient({ fetch: fakeFetch });

    const result = await client.queryBatch([
      { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.20' },
      { package: { name: 'foo', ecosystem: 'PyPI' }, version: '1.0.0' },
    ]);

    expect(result).toEqual(body);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://api.osv.dev/v1/querybatch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      queries: [
        { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.20' },
        { package: { name: 'foo', ecosystem: 'PyPI' }, version: '1.0.0' },
      ],
    });
  });

  it('returns empty results without calling fetch when queries is empty', async () => {
    const fakeFetch = vi.fn();
    const client = createOsvClient({ fetch: fakeFetch });
    const result = await client.queryBatch([]);
    expect(result).toEqual({ results: [] });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('retries a 503 then succeeds', async () => {
    const ok: OsvBatchResponse = { results: [{}] };
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, 'try again'))
      .mockResolvedValueOnce(jsonResponse(ok));
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 3 });

    // Skip the backoff sleep without breaking async logic.
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const result = await client.queryBatch([
      { package: { name: 'x', ecosystem: 'npm' }, version: '1' },
    ]);
    expect(result).toEqual(ok);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('throws OsvClientError after maxRetries 503s', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(errorResponse(503, 'down'));
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 2 });

    await expect(
      client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }]),
    ).rejects.toBeInstanceOf(OsvClientError);

    // initial + 2 retries = 3 calls
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('splits >100 queries into multiple requests', async () => {
    const fakeFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as { queries: unknown[] };
      // Echo one empty hit per query.
      return Promise.resolve(
        jsonResponse({ results: parsed.queries.map(() => ({})) } satisfies OsvBatchResponse),
      );
    });
    const client = createOsvClient({ fetch: fakeFetch });

    const queries = Array.from({ length: 250 }, (_, i) => ({
      package: { name: `pkg-${i}`, ecosystem: 'npm' as const },
      version: '1.0.0',
    }));
    const res = await client.queryBatch(queries);

    expect(res.results).toHaveLength(250);
    // 250 / 100 → 3 chunks (100 + 100 + 50)
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    const sizes = fakeFetch.mock.calls.map(
      (call) => (JSON.parse(call[1].body as string).queries as unknown[]).length,
    );
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('respects custom endpoint', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = createOsvClient({ fetch: fakeFetch, endpoint: 'https://osv.test/api/' });
    await client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }]);
    // Trailing slash on endpoint should be stripped before path is joined.
    expect(fakeFetch.mock.calls[0]![0]).toBe('https://osv.test/api/v1/querybatch');
  });
});

describe('createOsvClient.getVuln', () => {
  it('GETs /v1/vulns/{id} and returns the body', async () => {
    const body: OsvVuln = {
      id: 'GHSA-aaaa-bbbb-cccc',
      aliases: ['CVE-2025-12345'],
      summary: 'Bad bug',
    };
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = createOsvClient({ fetch: fakeFetch });

    const result = await client.getVuln('GHSA-aaaa-bbbb-cccc');
    expect(result).toEqual(body);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://api.osv.dev/v1/vulns/GHSA-aaaa-bbbb-cccc');
    expect(init.method).toBe('GET');
  });

  it('does NOT retry a 404 — throws immediately', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(errorResponse(404, 'not found'));
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 3 });

    const err = await client.getVuln('missing').catch((e) => e);
    expect(err).toBeInstanceOf(OsvClientError);
    expect((err as OsvClientError).status).toBe(404);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a 400', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(errorResponse(400, 'bad request'));
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 3 });
    await expect(client.getVuln('bad')).rejects.toBeInstanceOf(OsvClientError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('createOsvClient timeout', () => {
  it('aborts and throws OsvClientError when the request exceeds timeoutMs', async () => {
    // Simulate a fetch that respects AbortSignal: rejects with AbortError when
    // the signal aborts. Use a tiny timeout so test runs fast.
    const fakeFetch = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit): Promise<Response> => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener('abort', () => {
            const err: Error & { name: string } = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
    const client = createOsvClient({ fetch: fakeFetch, timeoutMs: 5, maxRetries: 0 });

    const err = await client
      .queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(OsvClientError);
    expect((err as OsvClientError).message).toMatch(/timed out/);
  });

  it('reports "aborted by caller" when an external signal aborts mid-flight (not "timed out")', async () => {
    // Regression: previously every AbortError was labelled "timed out", even
    // when the abort came from the EXTERNAL caller signal rather than the
    // internal request timer. Operators reading logs would be misled into
    // thinking OSV was slow when the parent orchestrator had explicitly
    // cancelled. fetchOnce now distinguishes the two by tracking whether the
    // internal timer fired.
    //
    // We exercise the fetchOnce branch directly by aborting AFTER the request
    // has started (withRetries short-circuits a pre-aborted signal before
    // fetchOnce even runs).
    const controller = new AbortController();
    const fakeFetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      // Trigger the external abort first — this fires the relay inside
      // fetchOnce, which calls controller.abort() WITHOUT setting
      // internalTimedOut. Then bounce back as AbortError like real fetch.
      controller.abort();
      const sig = (init?.signal ?? undefined) as AbortSignal | undefined;
      // Yield a tick so the listener inside fetchOnce sees the abort and
      // calls the internal controller.abort() — that propagates to `sig`
      // (the combined controller signal) so the assertion below holds.
      await new Promise<void>((r) => setImmediate(r));
      if (sig?.aborted) {
        const err = new DOMException('Aborted', 'AbortError');
        throw err;
      }
      return new Promise<Response>(() => undefined);
    });
    // Generous internal timeout so it never naturally fires within the test —
    // confirms the abort-message branch is selected by external signal only.
    const client = createOsvClient({ fetch: fakeFetch, timeoutMs: 10_000, maxRetries: 0 });
    const err = await client
      .queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }], {
        signal: controller.signal,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OsvClientError);
    // The key assertion: NOT labelled "timed out" — the external caller
    // aborted, and the message must say so.
    expect((err as OsvClientError).message).toMatch(/aborted by caller/);
    expect((err as OsvClientError).message).not.toMatch(/timed out/);
  });
});

describe('createOsvClient network error', () => {
  it('retries on a thrown network error and surfaces OsvClientError after exhaustion', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 2 });
    await expect(
      client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }]),
    ).rejects.toBeInstanceOf(OsvClientError);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });
});

describe('createOsvClient external-abort cancellation', () => {
  it('does NOT retry after the caller-supplied signal aborts during a request', async () => {
    // Codex P1 round 8: aborted requests used to feed back into the retry
    // loop because the OsvClientError didn't carry an AbortError cause.
    // Now the retry loop short-circuits on either `signal.aborted` OR an
    // AbortError-cause failure.
    const controller = new AbortController();
    const fakeFetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      // Abort mid-flight, then bounce the abort back as an AbortError —
      // mimicking real fetch behavior when its signal fires.
      controller.abort();
      const err = new DOMException('Aborted', 'AbortError');
      (init?.signal as AbortSignal | undefined)?.dispatchEvent(new Event('abort'));
      throw err;
    });
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 5 });
    await expect(
      client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OsvClientError);
    // Exactly ONE fetch attempt — no retry after the abort.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the signal is already aborted before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const fakeFetch = vi.fn().mockResolvedValue(errorResponse(503, 'down'));
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 5 });
    await expect(
      client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OsvClientError);
    // Either zero fetches (pre-loop check) or at most one (loop entered and
    // bailed). Anything more means we ignored the abort and retried.
    expect(fakeFetch.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('does NOT retry after the signal aborts during the backoff sleep', async () => {
    // First call returns 503 (retryable); during the backoff, the caller
    // aborts. The loop must exit instead of running another attempt.
    const controller = new AbortController();
    let attempts = 0;
    const fakeFetch = vi.fn().mockImplementation(async () => {
      attempts += 1;
      return errorResponse(503, 'try again');
    });
    // Intercept setTimeout to abort the controller in place of waiting.
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      // Abort BEFORE invoking the timer callback — the sleep helper's
      // listener fires, rejecting the sleep, and the retry loop exits.
      controller.abort();
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const client = createOsvClient({ fetch: fakeFetch, maxRetries: 5 });
    await expect(
      client.queryBatch([{ package: { name: 'x', ecosystem: 'npm' }, version: '1' }], {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OsvClientError);
    expect(attempts).toBe(1);
  });
});
