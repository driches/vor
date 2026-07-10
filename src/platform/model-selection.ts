import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '../config/defaults.js';
import { inferProviderFromModel, type ProviderId } from '../llm/index.js';

export interface ModelSelectionInput {
  model: string;
  providerPreference?: ProviderId;
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
}

export interface ModelSelection {
  model: string;
  provider: ProviderId;
}

export function assertValidProviderOverride(
  value: string | undefined,
): asserts value is ProviderId | undefined {
  if (value === undefined || value === 'anthropic' || value === 'openai') return;
  throw new Error(
    `Invalid provider_override "${value}". Must be "anthropic" or "openai" (or omit to infer from model id).`,
  );
}

/** Resolve a provider-specific default without changing the legacy overall default. */
export function resolveModelSelection(input: ModelSelectionInput): ModelSelection {
  const useOpenAIDefault =
    input.model === DEFAULT_ANTHROPIC_MODEL &&
    (input.providerPreference === 'openai' ||
      (input.providerPreference === undefined && input.hasOpenAIKey && !input.hasAnthropicKey));
  const model = useOpenAIDefault ? DEFAULT_OPENAI_MODEL : input.model;
  return {
    model,
    provider: input.providerPreference ?? inferProviderFromModel(model),
  };
}
