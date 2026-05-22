import { describe, expect, it } from 'vitest';
import { InMemoryScanCache, NoopScanCache } from './cache.js';

describe('InMemoryScanCache', () => {
  it('returns undefined for a missing key', () => {
    const cache = new InMemoryScanCache();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('returns the value after set', () => {
    const cache = new InMemoryScanCache();
    cache.set('k', { foo: 'bar' });
    expect(cache.get('k')).toEqual({ foo: 'bar' });
  });

  it('preserves the generic type on get', () => {
    const cache = new InMemoryScanCache();
    cache.set<number>('count', 42);
    const v = cache.get<number>('count');
    // Compile-time: v is `number | undefined`. Runtime: equals 42.
    expect(v).toBe(42);
  });

  it('overwrites on repeated set', () => {
    const cache = new InMemoryScanCache();
    cache.set('k', 1);
    cache.set('k', 2);
    expect(cache.get('k')).toBe(2);
  });

  it('increments hit_count on a present key', () => {
    const cache = new InMemoryScanCache();
    cache.set('k', 'v');
    cache.get('k');
    cache.get('k');
    expect(cache.hit_count).toBe(2);
    expect(cache.miss_count).toBe(0);
  });

  it('increments miss_count on a missing key', () => {
    const cache = new InMemoryScanCache();
    cache.get('absent-1');
    cache.get('absent-2');
    expect(cache.miss_count).toBe(2);
    expect(cache.hit_count).toBe(0);
  });

  it('treats explicit undefined value as a hit', () => {
    // Has-based check: storing undefined still registers as present.
    const cache = new InMemoryScanCache();
    cache.set('k', undefined);
    const v = cache.get('k');
    expect(v).toBeUndefined();
    expect(cache.hit_count).toBe(1);
    expect(cache.miss_count).toBe(0);
  });

  it('isolates state across instances', () => {
    const a = new InMemoryScanCache();
    const b = new InMemoryScanCache();
    a.set('k', 1);
    expect(b.get('k')).toBeUndefined();
    expect(b.miss_count).toBe(1);
    expect(a.miss_count).toBe(0);
  });
});

describe('NoopScanCache', () => {
  it('always returns undefined from get, never stores set values', () => {
    const cache = new NoopScanCache();
    cache.set('k', { foo: 'bar' });
    expect(cache.get('k')).toBeUndefined();
    // A second set with the same key still leaves the slot empty.
    cache.set('k', 'second-value');
    expect(cache.get('k')).toBeUndefined();
  });

  it('reports zero hit_count and miss_count regardless of usage', () => {
    const cache = new NoopScanCache();
    cache.set('k', 1);
    cache.get('k');
    cache.get('miss');
    expect(cache.hit_count).toBe(0);
    expect(cache.miss_count).toBe(0);
  });
});
