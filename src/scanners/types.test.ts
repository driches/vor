import { describe, expect, it } from 'vitest';
import { emptyResult } from './types.js';

describe('emptyResult', () => {
  it('returns a result tagged with the given scanner id', () => {
    const r = emptyResult('dependency-cve');
    expect(r.scanner).toBe('dependency-cve');
  });

  it('returns an empty findings array', () => {
    expect(emptyResult('secrets').findings).toEqual([]);
  });

  it('returns an empty errors array', () => {
    expect(emptyResult('sast').errors).toEqual([]);
  });

  it('defaults duration_ms to 0', () => {
    expect(emptyResult('container-cve').metrics.duration_ms).toBe(0);
  });

  it('threads the duration_ms argument into metrics', () => {
    expect(emptyResult('dependency-cve', 42).metrics.duration_ms).toBe(42);
  });

  it('zeros the other metric counters', () => {
    const m = emptyResult('dependency-cve').metrics;
    expect(m.files_examined).toBe(0);
    expect(m.network_calls).toBe(0);
    expect(m.cache_hits).toBe(0);
  });
});
