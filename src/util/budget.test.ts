import { describe, expect, it } from 'vitest';
import { Budget } from './budget.js';
import { BudgetError } from './errors.js';

const limits = {
  maxTurns: 5,
  warnFraction: 0.8,
  maxInputTokens: 1000,
  maxOutputTokens: 500,
};

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
    b.addUsage(500, 100);
    expect(() => b.addUsage(600, 0)).toThrowError(BudgetError);
  });

  it('throws when output tokens exceed limit', () => {
    const b = new Budget(limits);
    b.addUsage(100, 400);
    expect(() => b.addUsage(0, 200)).toThrowError(BudgetError);
  });

  it('shouldWrapUp false below warn threshold', () => {
    const b = new Budget(limits);
    b.startTurn();
    b.addUsage(100, 50);
    expect(b.shouldWrapUp()).toBe(false);
  });

  it('shouldWrapUp true once turn warn threshold crossed', () => {
    const b = new Budget(limits);
    for (let i = 0; i < 4; i++) b.startTurn();
    expect(b.shouldWrapUp()).toBe(true);
  });

  it('shouldWrapUp true once input-token threshold crossed', () => {
    const b = new Budget(limits);
    b.addUsage(801, 0);
    expect(b.shouldWrapUp()).toBe(true);
  });
});
