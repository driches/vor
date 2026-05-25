import { describe, expect, it } from 'vitest';
import { costFromUsage, MODEL_PRICING, pricingForModel } from './pricing.js';

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

  it('prices Opus 4.5, 4.6, and 4.7 at the new lower Opus tier ($5/$25)', () => {
    const p47 = pricingForModel('claude-opus-4-7');
    const p46 = pricingForModel('claude-opus-4-6');
    const p45 = pricingForModel('claude-opus-4-5');
    expect(p47).toEqual(p46);
    expect(p47).toEqual(p45);
    expect(p47!.input).toBe(5);
    expect(p47!.output).toBe(25);
    expect(p47!.cache_creation).toBe(6.25);
    expect(p47!.cache_read).toBe(0.5);
  });

  it('keeps Opus 4.1 at the legacy higher Opus tier ($15/$75)', () => {
    const p41 = pricingForModel('claude-opus-4-1');
    expect(p41!.input).toBe(15);
    expect(p41!.output).toBe(75);
    expect(p41!.cache_creation).toBe(18.75);
    expect(p41!.cache_read).toBe(1.5);
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
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
  });
});

describe('costFromUsage', () => {
  it('computes Sonnet cost using the table rates', () => {
    const cost = costFromUsage('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    // 3 + 15 + 3.75 + 0.3 = 22.05
    expect(cost).toBeCloseTo(22.05, 4);
  });

  it('computes Haiku cost at 1/3 the Sonnet input rate', () => {
    const cost = costFromUsage('claude-haiku-4-5', { inputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(1, 4);
  });

  it('treats missing usage fields as zero', () => {
    expect(costFromUsage('claude-sonnet-4-6', {})).toBe(0);
    expect(costFromUsage('claude-sonnet-4-6', { inputTokens: 100 })).toBeGreaterThan(0);
  });

  it('falls back to Sonnet rates for unknown model (no NaN cost)', () => {
    const cost = costFromUsage('claude-imaginary-99', { inputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3, 4);
  });
});
