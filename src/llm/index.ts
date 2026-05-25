/**
 * Provider router. Callers go through `createProvider()` and receive an
 * `LLMProvider`; they never instantiate vendor adapters directly. Until
 * Tasks 2 and 3 land, the concrete adapters throw — this keeps the
 * canonical surface usable for tests + downstream typing today without
 * forcing the implementation order.
 */

import type { LLMProvider, ProviderId } from './types.js';

export * from './types.js';

/**
 * Best-effort provider inference from a model id. Used when the user does
 * not set `provider:` explicitly in `.code-review.yml` — most users won't.
 *
 * Recognized prefixes:
 *  - `claude-*` → Anthropic
 *  - `gpt-*`, `o<digit>*`, `chatgpt-*` → OpenAI
 *
 * Anything else throws with a message pointing the user at the explicit
 * config knob. We deliberately do NOT silently fall back to a default —
 * a typo in `model:` would otherwise route to the wrong vendor and burn
 * an API key on a confusing 4xx.
 */
export function inferProviderFromModel(model: string): ProviderId {
  if (model.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt-)/.test(model)) return 'openai';
  throw new Error(
    `Cannot infer provider from model "${model}". Set 'provider:' explicitly in .code-review.yml.`,
  );
}

export interface CreateProviderInput {
  modelId: string;
  apiKey: string;
  providerHint?: ProviderId;
}

/**
 * Factory. Uses `providerHint` when supplied (config has the final say),
 * otherwise infers from the model id. Concrete adapters land in Tasks 2-3.
 */
export function createProvider(input: CreateProviderInput): LLMProvider {
  const id = input.providerHint ?? inferProviderFromModel(input.modelId);
  switch (id) {
    case 'anthropic':
      throw new Error('AnthropicProvider not yet implemented — Task 2');
    case 'openai':
      throw new Error('OpenAIProvider not yet implemented — Task 3');
  }
}
