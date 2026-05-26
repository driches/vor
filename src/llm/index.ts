/**
 * Provider router. Callers go through `createProvider()` and receive an
 * `LLMProvider`; they never instantiate vendor adapters directly. Both
 * Anthropic and OpenAI adapters are implemented; runner wiring (Task 4)
 * is the next step.
 */

import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
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
 * otherwise infers from the model id.
 */
export function createProvider(input: CreateProviderInput): LLMProvider {
  const id = input.providerHint ?? inferProviderFromModel(input.modelId);
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider(input.apiKey);
    case 'openai':
      return new OpenAIProvider(input.apiKey);
    default: {
      // Exhaustiveness guard: TypeScript will flag this assignment if a new
      // ProviderId is added without a corresponding case, and at runtime it
      // throws cleanly for any string that bypasses the type system (e.g. a
      // typo'd INPUT_PROVIDER env var that wasn't validated upstream).
      const _exhaustive: never = id;
      throw new Error(
        `Unknown provider "${String(_exhaustive)}". Valid: anthropic | openai.`,
      );
    }
  }
}
