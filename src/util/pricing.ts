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
  // Opus 4.5, 4.6, and 4.7 share the lower-tier Opus pricing that Anthropic
  // introduced starting with 4.5. Opus 4.1 retains the original higher Opus
  // tier and is kept here so legacy configs still resolve to real pricing
  // instead of falling through to the Sonnet fallback.
  'claude-opus-4-7': { input: 5, output: 25, cache_creation: 6.25, cache_read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cache_creation: 6.25, cache_read: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cache_creation: 6.25, cache_read: 0.5 },
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

/**
 * Sonnet 4.6 rates, used as a last-resort fallback for cost calculation when
 * the active model is unknown to the pricing table. Kept inline so a future
 * accidental delete of the Sonnet key in MODEL_PRICING still produces a
 * sensibly-scaled cost number instead of `NaN`.
 */
const SONNET_FALLBACK_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cache_creation: 3.75,
  cache_read: 0.3,
};

/**
 * Compute the dollar cost for a single API response usage block. Centralizes
 * the formula so the production runner, the eval harness, and any future
 * per-model reporting use one source of truth — drift here used to be a real
 * bug (runner hardcoded Sonnet rates while operators ran other models).
 *
 * Three-level fallback: active model → Sonnet table entry → inline Sonnet
 * constants. The active-model miss path is silent here; callers that want a
 * warning should check `pricingForModel(model) === undefined` themselves.
 */
export function costFromUsage(
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  },
): number {
  const pricing = pricingForModel(model) ?? pricingForModel('claude-sonnet-4-6') ?? SONNET_FALLBACK_PRICING;
  return (
    ((usage.inputTokens ?? 0) * pricing.input) / 1_000_000 +
    ((usage.outputTokens ?? 0) * pricing.output) / 1_000_000 +
    ((usage.cacheCreationTokens ?? 0) * pricing.cache_creation) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * pricing.cache_read) / 1_000_000
  );
}
