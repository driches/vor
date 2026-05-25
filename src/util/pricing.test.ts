import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, pricingForModel } from './pricing.js';

describe('pricingForModel', () => {
  it('returns pricing for known Sonnet 4.6', () => {
    const p = pricingForModel('claude-sonnet-4-6');
    expect(p).toBeDefined();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(15);
    expect(p!.cache_creation).toBe(3.75);
    expect(p!.cache_read).toBe(0.3);
  });

  it('returns pricing for known Haiku 4.5', () => {
    const p = pricingForModel('claude-haiku-4-5');
    expect(p).toBeDefined();
    expect(p!.input).toBe(1);
    expect(p!.output).toBe(5);
    expect(p!.cache_creation).toBe(1.25);
    expect(p!.cache_read).toBe(0.1);
  });

  it('returns pricing for Opus 4-7 and 4-1 at same rates', () => {
    const p47 = pricingForModel('claude-opus-4-7');
    const p41 = pricingForModel('claude-opus-4-1');
    expect(p47).toEqual(p41);
    expect(p47!.input).toBe(15);
    expect(p47!.output).toBe(75);
  });

  it('returns undefined for unknown model id (lets the runner fall back, the eval throw)', () => {
    expect(pricingForModel('claude-imaginary-99')).toBeUndefined();
    expect(pricingForModel('')).toBeUndefined();
  });

  it('exposes the same table via MODEL_PRICING (for callers needing the full map)', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toEqual(pricingForModel('claude-sonnet-4-6'));
    expect(Object.keys(MODEL_PRICING).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
  });
});
