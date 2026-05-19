/**
 * Exponential backoff with jitter.
 */

export interface RetryOptions {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULTS: Required<Omit<RetryOptions, 'shouldRetry' | 'onRetry'>> = {
  retries: 3,
  minDelayMs: 250,
  maxDelayMs: 8_000,
  factor: 2,
};

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const cfg = { ...DEFAULTS, ...opts };
  let lastErr: unknown;

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.retries) break;
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) break;

      const base = Math.min(cfg.maxDelayMs, cfg.minDelayMs * Math.pow(cfg.factor, attempt));
      const jitter = Math.random() * base * 0.3;
      const delay = Math.floor(base + jitter);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
