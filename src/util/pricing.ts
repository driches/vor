/**
 * Per-million-token pricing for Claude models. Source: Anthropic pricing
 * page (rates as of 2026-05).
 *
 * Owned here (not in scripts/eval/) so the production agent runner and the
 * test-only eval harness both consume the same table. Out-of-date entries
 * misreport cost_usd; update whenever Anthropic publishes new rates.
 */

export interface ModelPricing {
  /** $ per million input tokens (non-cached). */
  input: number;
  /** $ per million output tokens. */
  output: number;
  /** $ per million input tokens written to the prompt cache. */
  cache_creation: number;
  /** $ per million input tokens read from the prompt cache. */
  cache_read: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_creation: 3.75, cache_read: 0.3 },
  // Opus 4-7 and 4-1 share Opus-tier pricing today. Keep both keys so legacy
  // configs still resolve to real pricing instead of falling through to the
  // sonnet fallback.
  'claude-opus-4-7': { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.5 },
  'claude-opus-4-1': { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_creation: 1.25, cache_read: 0.1 },
};

/**
 * Returns pricing for a given model id, or `undefined` when the id is not
 * known. Callers decide whether to throw (eval harness, fail-fast before a
 * run) or fall back to a default rate (production runner, after the API
 * spend already happened).
 */
export function pricingForModel(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model];
}
