/**
 * In-memory scanner cache. One instance is created per review run and handed
 * to every scanner via `ScannerDeps.cache`. The cache is GCed when the action
 * process exits — there is no LRU, TTL, or persistence here. The intent is to
 * avoid duplicate OSV / API lookups within a single PR (e.g. two scanners
 * resolving the same lockfile entry).
 */
import type { ScanCache } from './types.js';

export class InMemoryScanCache implements ScanCache {
  private readonly store = new Map<string, unknown>();
  private _hit_count = 0;
  private _miss_count = 0;

  get<T>(key: string): T | undefined {
    if (this.store.has(key)) {
      this._hit_count += 1;
      return this.store.get(key) as T;
    }
    this._miss_count += 1;
    return undefined;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  get hit_count(): number {
    return this._hit_count;
  }

  get miss_count(): number {
    return this._miss_count;
  }
}

/**
 * No-op scanner cache used when `security.cache.enabled: false`. Every `get`
 * misses, every `set` is dropped. Counters stay at zero so metrics still
 * reflect "cache made no difference."
 */
export class NoopScanCache implements ScanCache {
  readonly hit_count = 0;
  readonly miss_count = 0;

  get<T>(_key: string): T | undefined {
    return undefined;
  }

  set<T>(_key: string, _value: T): void {
    // no-op
  }
}
