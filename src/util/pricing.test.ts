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
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'o1-mini',
      'o1-preview',
      'o3',
      'o3-mini',
      'o4-mini',
    ]);
  });

  it('prices GPT-4.1 at $2/$8 input/output with $0.5 cache read and no cache creation cost', () => {
    const p = pricingForModel('gpt-4.1');
    expect(p).toBeDefined();
    expect(p!.input).toBe(2);
    expect(p!.output).toBe(8);
    expect(p!.cache_read).toBe(0.5);
    // OpenAI cached prompt writes are free; cache_creation stays undefined.
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices GPT-4.1-mini at $0.4/$1.6 with $0.1 cache read', () => {
    const p = pricingForModel('gpt-4.1-mini');
    expect(p).toBeDefined();
    expect(p!.input).toBe(0.4);
    expect(p!.output).toBe(1.6);
    expect(p!.cache_read).toBe(0.1);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices GPT-4.1-nano at $0.1/$0.4 with $0.025 cache read', () => {
    const p = pricingForModel('gpt-4.1-nano');
    expect(p).toBeDefined();
    expect(p!.input).toBe(0.1);
    expect(p!.output).toBe(0.4);
    expect(p!.cache_read).toBe(0.025);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices GPT-4o at $2.5/$10 with $1.25 cache read', () => {
    const p = pricingForModel('gpt-4o');
    expect(p).toBeDefined();
    expect(p!.input).toBe(2.5);
    expect(p!.output).toBe(10);
    expect(p!.cache_read).toBe(1.25);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices GPT-4o-mini at $0.15/$0.6 with $0.075 cache read', () => {
    const p = pricingForModel('gpt-4o-mini');
    expect(p).toBeDefined();
    expect(p!.input).toBe(0.15);
    expect(p!.output).toBe(0.6);
    expect(p!.cache_read).toBe(0.075);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o4-mini at $1.1/$4.4 with $0.275 cache read', () => {
    const p = pricingForModel('o4-mini');
    expect(p).toBeDefined();
    expect(p!.input).toBe(1.1);
    expect(p!.output).toBe(4.4);
    expect(p!.cache_read).toBe(0.275);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o1 at $15/$60 with $7.5 cache read', () => {
    const p = pricingForModel('o1');
    expect(p).toBeDefined();
    expect(p!.input).toBe(15);
    expect(p!.output).toBe(60);
    expect(p!.cache_read).toBe(7.5);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o1-mini at $3/$12 with $1.5 cache read', () => {
    const p = pricingForModel('o1-mini');
    expect(p).toBeDefined();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(12);
    expect(p!.cache_read).toBe(1.5);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o1-preview at $15/$60 with $7.5 cache read (same tier as o1)', () => {
    const p = pricingForModel('o1-preview');
    expect(p).toBeDefined();
    expect(p!.input).toBe(15);
    expect(p!.output).toBe(60);
    expect(p!.cache_read).toBe(7.5);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o3 at $10/$40 with $2.5 cache read', () => {
    const p = pricingForModel('o3');
    expect(p).toBeDefined();
    expect(p!.input).toBe(10);
    expect(p!.output).toBe(40);
    expect(p!.cache_read).toBe(2.5);
    expect(p!.cache_creation).toBeUndefined();
  });

  it('prices o3-mini at $1.1/$4.4 with $0.275 cache read (same tier as o4-mini)', () => {
    const p = pricingForModel('o3-mini');
    expect(p).toBeDefined();
    expect(p!.input).toBe(1.1);
    expect(p!.output).toBe(4.4);
    expect(p!.cache_read).toBe(0.275);
    expect(p!.cache_creation).toBeUndefined();
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
