/**
 * Tracks per-review budgets: turns, input tokens, output tokens, commented count.
 * The runner consults this between turns to decide when to wrap up.
 */

import { BudgetError } from './errors.js';

export interface BudgetLimits {
  maxTurns: number;
  /** Soft warning threshold as fraction of limit (e.g., 0.8). */
  warnFraction: number;
  /** Hard input token cap. */
  maxInputTokens: number;
  /** Hard output token cap. */
  maxOutputTokens: number;
}

export interface BudgetState {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export class Budget {
  private state: BudgetState = { turns: 0, inputTokens: 0, outputTokens: 0 };

  constructor(public readonly limits: BudgetLimits) {}

  /** Call at the start of every turn. Throws if max turns reached. */
  startTurn(): void {
    this.state.turns += 1;
    if (this.state.turns > this.limits.maxTurns) {
      throw new BudgetError(`maxTurns exceeded (${this.state.turns} > ${this.limits.maxTurns})`);
    }
  }

  /** Record token usage from a model response. */
  addUsage(input: number, output: number): void {
    this.state.inputTokens += input;
    this.state.outputTokens += output;

    if (this.state.inputTokens > this.limits.maxInputTokens) {
      throw new BudgetError(
        `maxInputTokens exceeded (${this.state.inputTokens} > ${this.limits.maxInputTokens})`,
      );
    }
    if (this.state.outputTokens > this.limits.maxOutputTokens) {
      throw new BudgetError(
        `maxOutputTokens exceeded (${this.state.outputTokens} > ${this.limits.maxOutputTokens})`,
      );
    }
  }

  /** True once we cross the warn threshold — runner should signal "wrap up". */
  shouldWrapUp(): boolean {
    const turnFrac = this.state.turns / this.limits.maxTurns;
    const inFrac = this.state.inputTokens / this.limits.maxInputTokens;
    const outFrac = this.state.outputTokens / this.limits.maxOutputTokens;
    return (
      turnFrac >= this.limits.warnFraction ||
      inFrac >= this.limits.warnFraction ||
      outFrac >= this.limits.warnFraction
    );
  }

  snapshot(): Readonly<BudgetState> {
    return { ...this.state };
  }
}
