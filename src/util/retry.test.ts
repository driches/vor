import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry.js';

describe('retry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries failing function up to `retries` times then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });
    const result = await retry(fn, { retries: 3, minDelayMs: 1, maxDelayMs: 5 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting retries', async () => {
    const err = new Error('always fails');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry(fn, { retries: 2, minDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('stops retrying when shouldRetry returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      retry(fn, {
        retries: 5,
        minDelayMs: 1,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with attempt and delay', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    await retry(fn, { retries: 1, minDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[1]).toBe(0); // attempt index
  });
});
