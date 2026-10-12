// Test fixture: subtle rate-limit bug. Not production code, not imported.

interface RateStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

/**
 * Allow up to `limit` requests per `windowMs` milliseconds per key.
 * Returns true if the request is allowed, false if rate-limited.
 */
export async function fixedWindowAllow(
  store: RateStore,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<boolean> {
  const bucket = Math.floor(nowMs / windowMs);
  const bucketKey = `${key}:${bucket}`;
  const count = await store.incr(bucketKey);
  if (count === 1) {
    await store.expire(bucketKey, Math.ceil(windowMs / 1000));
  }
  return count <= limit;
}
