import { describe, expect, it } from 'vitest';
import { Budget } from './budget.js';
import { BudgetError } from './errors.js';

const limits = {
  maxTurns: 5,
  warnFraction: 0.8,
  maxInputTokens: 1000,
  maxOutputTokens: 500,
};

const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5';

describe('Budget', () => {
  it('starts turns up to maxTurns without throwing', () => {
    const b = new Budget(limits);
    for (let i = 0; i < 5; i++) b.startTurn();
    expect(b.snapshot().turns).toBe(5);
  });

  it('throws BudgetError on turn maxTurns+1', () => {
    const b = new Budget(limits);
    for (let i = 0; i < 5; i++) b.startTurn();
    expect(() => b.startTurn()).toThrowError(BudgetError);
  });

  it('throws when input tokens exceed limit', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 500, output_tokens: 100 });
    expect(() => b.addUsage(SONNET, { input_tokens: 600, output_tokens: 0 })).toThrowError(
      BudgetError,
    );
  });

  it('throws when output tokens exceed limit', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 100, output_tokens: 400 });
    expect(() => b.addUsage(SONNET, { input_tokens: 0, output_tokens: 200 })).toThrowError(
      BudgetError,
    );
  });

  it('shouldWrapUp false below warn threshold', () => {
    const b = new Budget(limits);
    b.startTurn();
    b.addUsage(SONNET, { input_tokens: 100, output_tokens: 50 });
    expect(b.shouldWrapUp()).toBe(false);
  });

  it('shouldWrapUp true once turn warn threshold crossed', () => {
    const b = new Budget(limits);
    for (let i = 0; i < 4; i++) b.startTurn();
    expect(b.shouldWrapUp()).toBe(true);
  });

  it('shouldWrapUp true once input-token threshold crossed', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 801, output_tokens: 0 });
    expect(b.shouldWrapUp()).toBe(true);
  });

  it('counts cache_creation toward the input cap (billed at 1.25×, full-cost equivalent)', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, {
      input_tokens: 400,
      output_tokens: 0,
      cache_creation_input_tokens: 500,
    });
    // 400 + 500 = 900 (under 1000) → OK
    expect(() => b.addUsage(SONNET, { input_tokens: 200, output_tokens: 0 })).toThrowError(
      BudgetError,
    );
  });

  it('does NOT count cache_read toward the input cap (billed at 0.1×, would over-trip the cap)', () => {
    const b = new Budget(limits);
    // Inject a realistic cache_read pool — multi-hundred-K is common with caching.
    b.addUsage(SONNET, {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 800_000,
    });
    // Budget gate sees 100 billable input, not 800,100. Adding 500 more should still fit.
    expect(() => b.addUsage(SONNET, { input_tokens: 500, output_tokens: 50 })).not.toThrow();
  });

  it('aggregates totals across models (Sonnet driver + Haiku worker share the cap)', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 600, output_tokens: 300 });
    // 600 + 500 = 1100 > 1000 — Haiku contribution must trip the cap too.
    expect(() => b.addUsage(HAIKU, { input_tokens: 500, output_tokens: 0 })).toThrowError(
      BudgetError,
    );
  });

  it('snapshotByModel returns per-model usage entries', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 1000,
    });
    b.addUsage(HAIKU, {
      input_tokens: 80,
      output_tokens: 40,
    });

    const byModel = b.snapshotByModel();
    expect(byModel).toHaveLength(2);

    const sonnet = byModel.find((e) => e.model === SONNET);
    expect(sonnet?.usage.inputTokens).toBe(100);
    expect(sonnet?.usage.outputTokens).toBe(50);
    expect(sonnet?.usage.cacheCreationTokens).toBe(25);
    expect(sonnet?.usage.cacheReadTokens).toBe(1000);

    const haiku = byModel.find((e) => e.model === HAIKU);
    expect(haiku?.usage.inputTokens).toBe(80);
    expect(haiku?.usage.outputTokens).toBe(40);
    expect(haiku?.usage.cacheCreationTokens).toBe(0);
    expect(haiku?.usage.cacheReadTokens).toBe(0);
  });

  it('snapshot returns aggregated totals across all models', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 100, output_tokens: 50 });
    b.addUsage(HAIKU, { input_tokens: 30, output_tokens: 20 });
    const snap = b.snapshot();
    expect(snap.inputTokens).toBe(130);
    expect(snap.outputTokens).toBe(70);
  });

  it('leaves state unchanged when addUsage throws BudgetError (no partial mutation)', () => {
    const b = new Budget(limits);
    b.addUsage(SONNET, { input_tokens: 500, output_tokens: 200 });
    const before = b.snapshot();
    // 500 + 600 = 1100 > cap of 1000 — should throw and leave state alone.
    expect(() => b.addUsage(SONNET, { input_tokens: 600, output_tokens: 0 })).toThrowError(
      BudgetError,
    );
    const after = b.snapshot();
    expect(after.inputTokens).toBe(before.inputTokens);
    expect(after.outputTokens).toBe(before.outputTokens);
  });
});
