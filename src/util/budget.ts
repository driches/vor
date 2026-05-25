/**
 * Tracks per-review budgets: turns, per-model token usage, posted-comment count.
 * The runner consults this between turns to decide when to wrap up.
 *
 * v0.3.0 — split usage into a per-model map so a Sonnet-driver + Haiku-worker
 * run can be priced and reported separately. Budget gates still operate on
 * cross-model totals (a worker that burns tokens contributes to the same
 * input/output caps as the driver).
 */

import { BudgetError } from './errors.js';

export interface BudgetLimits {
  maxTurns: number;
  /** Soft warning threshold as fraction of limit (e.g., 0.8). */
  warnFraction: number;
  /** Hard input token cap (counts non-cached input + cache_creation). */
  maxInputTokens: number;
  /** Hard output token cap. */
  maxOutputTokens: number;
}

/**
 * Raw usage shape from a single Anthropic API response. Matches
 * `Anthropic.MessageUsage` field names so callers can pass `response.usage`
 * directly without a translation layer.
 */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Accumulated usage for a single model over the run. */
export interface ModelUsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface BudgetState {
  turns: number;
  perModel: Map<string, ModelUsageAccumulator>;
}

export class Budget {
  private state: BudgetState = { turns: 0, perModel: new Map() };

  constructor(public readonly limits: BudgetLimits) {}

  /** Call at the start of every turn. Throws if max turns reached. */
  startTurn(): void {
    this.state.turns += 1;
    if (this.state.turns > this.limits.maxTurns) {
      throw new BudgetError(`maxTurns exceeded (${this.state.turns} > ${this.limits.maxTurns})`);
    }
  }

  /**
   * Record token usage from a model response, scoped to the model that
   * produced it (so cost can later be priced per-model). The cap check
   * counts BILLABLE input (non-cached input + cache_creation) across all
   * models, NOT cache reads — cache_read is billed at 0.1× and counting it
   * would make the default cap fire on turn 1 of any cached run. See
   * billableInputTokensForBudget in runner.ts for the asymmetry rationale.
   *
   * Checks run BEFORE the mutation so a thrown BudgetError leaves state
   * untouched. Preserves the invariant "throw iff cap exceeded, otherwise
   * state is consistent" — a future retry path that catches the error
   * would otherwise double-count whatever was committed before the throw.
   */
  addUsage(model: string, usage: ModelUsage): void {
    const inDelta = usage.input_tokens;
    const outDelta = usage.output_tokens;
    const creationDelta = usage.cache_creation_input_tokens ?? 0;
    const readDelta = usage.cache_read_input_tokens ?? 0;

    const proposedBillable = this.totalBillableInput() + inDelta + creationDelta;
    if (proposedBillable > this.limits.maxInputTokens) {
      throw new BudgetError(
        `maxInputTokens exceeded (${proposedBillable} > ${this.limits.maxInputTokens})`,
      );
    }
    const proposedOut = this.totalOutput() + outDelta;
    if (proposedOut > this.limits.maxOutputTokens) {
      throw new BudgetError(
        `maxOutputTokens exceeded (${proposedOut} > ${this.limits.maxOutputTokens})`,
      );
    }

    let m = this.state.perModel.get(model);
    if (m === undefined) {
      m = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      this.state.perModel.set(model, m);
    }
    m.inputTokens += inDelta;
    m.outputTokens += outDelta;
    m.cacheCreationTokens += creationDelta;
    m.cacheReadTokens += readDelta;
  }

  /** True once we cross the warn threshold — runner should signal "wrap up". */
  shouldWrapUp(): boolean {
    const turnFrac = this.state.turns / this.limits.maxTurns;
    const inFrac = this.totalBillableInput() / this.limits.maxInputTokens;
    const outFrac = this.totalOutput() / this.limits.maxOutputTokens;
    return (
      turnFrac >= this.limits.warnFraction ||
      inFrac >= this.limits.warnFraction ||
      outFrac >= this.limits.warnFraction
    );
  }

  snapshot(): {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  } {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    for (const m of this.state.perModel.values()) {
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheCreationTokens += m.cacheCreationTokens;
      cacheReadTokens += m.cacheReadTokens;
    }
    return {
      turns: this.state.turns,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    };
  }

  /** Per-model usage snapshot, for cost breakdown reporting. */
  snapshotByModel(): Array<{ model: string; usage: ModelUsageAccumulator }> {
    return Array.from(this.state.perModel.entries()).map(([model, usage]) => ({
      model,
      usage: { ...usage },
    }));
  }

  private totalBillableInput(): number {
    let total = 0;
    for (const m of this.state.perModel.values()) {
      total += m.inputTokens + m.cacheCreationTokens;
    }
    return total;
  }

  private totalOutput(): number {
    let total = 0;
    for (const m of this.state.perModel.values()) {
      total += m.outputTokens;
    }
    return total;
  }
}
