/**
 * Per-million-token pricing for Claude and OpenAI models. Source: vendor
 * pricing pages (rates as of 2026-05).
 *
 * Owned here (not in scripts/eval/) so the production agent runner and the
 * test-only eval harness both consume the same table. Out-of-date entries
 * misreport cost_usd; update whenever a vendor publishes new rates.
 */

export interface ModelPricing {
  /** $ per million input tokens (non-cached). */
  input: number;
  /** $ per million output tokens. */
  output: number;
  /**
   * $ per million input tokens written to the prompt cache. Anthropic-only —
   * OpenAI's cached prompts are written for free, so this is `undefined` on
   * OpenAI rows.
   */
  cache_creation?: number;
  /** $ per million input tokens read from the prompt cache. */
  cache_read?: number;
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
  // OpenAI rates from the published price list as of 2026-05. Verify before
  // each release; published rates shift.
  'gpt-4.1':       { input: 2,    output: 8,    cache_read: 0.5 },
  'gpt-4.1-mini':  { input: 0.4,  output: 1.6,  cache_read: 0.1 },
  'gpt-4.1-nano':  { input: 0.1,  output: 0.4,  cache_read: 0.025 },
  'gpt-4o':        { input: 2.5,  output: 10,   cache_read: 1.25 },
  'gpt-4o-mini':   { input: 0.15, output: 0.6,  cache_read: 0.075 },
  // GPT-5.x / Codex API pricing from OpenAI pricing page as of 2026-05.
  'gpt-5.5':        { input: 5,    output: 30,   cache_read: 0.5 },
  'gpt-5.4':        { input: 2.5,  output: 15,   cache_read: 0.25 },
  'gpt-5.4-mini':   { input: 0.75, output: 4.5,  cache_read: 0.075 },
  'gpt-5.4-nano':   { input: 0.2,  output: 1.25, cache_read: 0.02 },
  'gpt-5.3-codex':  { input: 1.75, output: 14,   cache_read: 0.175 },
  // o-series reasoning models. `inferProviderFromModel` routes any
  // `/^o\d/` id to OpenAI, so every o-prefix model needs a pricing entry
  // — without them, production silently falls back to Sonnet rates (3–5×
  // under-count) and the eval harness throws on a miss. Pricing entries
  // landed across two passes: o1/o3/o3-mini/o4-mini in #3300755077; the
  // o1-mini and o1-preview variants in #3300818612 (the regex also
  // matches them).
  'o1':            { input: 15,   output: 60,   cache_read: 7.5 },
  'o1-mini':       { input: 3,    output: 12,   cache_read: 1.5 },
  'o1-preview':    { input: 15,   output: 60,   cache_read: 7.5 },
  'o3':            { input: 10,   output: 40,   cache_read: 2.5 },
  'o3-mini':       { input: 1.1,  output: 4.4,  cache_read: 0.275 },
  'o4-mini':       { input: 1.1,  output: 4.4,  cache_read: 0.275 },
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
  // `cache_creation` / `cache_read` are optional on `ModelPricing` because
  // OpenAI rows have no cache_creation cost (cached writes are free, only
  // reads are billed at a discounted rate). Guard each with `?? 0` so an
  // OpenAI model that emits zero cache_creation_tokens against an
  // undefined `pricing.cache_creation` contributes $0 instead of `NaN`.
  return (
    ((usage.inputTokens ?? 0) * pricing.input) / 1_000_000 +
    ((usage.outputTokens ?? 0) * pricing.output) / 1_000_000 +
    ((usage.cacheCreationTokens ?? 0) * (pricing.cache_creation ?? 0)) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * (pricing.cache_read ?? 0)) / 1_000_000
  );
}
