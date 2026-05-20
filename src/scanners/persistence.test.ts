import { describe, expect, it } from 'vitest';
import { NoopStore } from './persistence.js';

describe('NoopStore', () => {
  it('load returns null', async () => {
    const s = new NoopStore();
    await expect(s.load()).resolves.toBeNull();
  });

  it('save resolves without throwing', async () => {
    const s = new NoopStore();
    await expect(s.save({ findings_first_seen: { fp1: 'abc1234' } })).resolves.toBeUndefined();
  });

  it('save accepts empty state', async () => {
    const s = new NoopStore();
    await expect(s.save({ findings_first_seen: {} })).resolves.toBeUndefined();
  });
});
