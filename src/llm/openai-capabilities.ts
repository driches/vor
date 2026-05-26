export interface OpenAIModelCapabilities {
  reasoning: boolean;
  temperature: boolean;
  promptCacheRetention24h: boolean;
}

const OPENAI_MODEL_CAPABILITIES: Record<string, OpenAIModelCapabilities> = {
  'gpt-4.1': { reasoning: false, temperature: true, promptCacheRetention24h: true },
  'gpt-4.1-mini': { reasoning: false, temperature: true, promptCacheRetention24h: false },
  'gpt-4.1-nano': { reasoning: false, temperature: true, promptCacheRetention24h: false },
  'gpt-4o': { reasoning: false, temperature: true, promptCacheRetention24h: false },
  'gpt-4o-mini': { reasoning: false, temperature: true, promptCacheRetention24h: false },
  o1: { reasoning: true, temperature: false, promptCacheRetention24h: false },
  'o1-mini': { reasoning: true, temperature: false, promptCacheRetention24h: false },
  'o1-preview': { reasoning: true, temperature: false, promptCacheRetention24h: false },
  o3: { reasoning: true, temperature: false, promptCacheRetention24h: false },
  'o3-mini': { reasoning: true, temperature: false, promptCacheRetention24h: false },
  'o4-mini': { reasoning: true, temperature: false, promptCacheRetention24h: false },
  'gpt-5.5': { reasoning: true, temperature: false, promptCacheRetention24h: true },
  'gpt-5.4': { reasoning: true, temperature: false, promptCacheRetention24h: true },
  'gpt-5.4-mini': { reasoning: true, temperature: false, promptCacheRetention24h: true },
  'gpt-5.4-nano': { reasoning: true, temperature: false, promptCacheRetention24h: true },
  'gpt-5.3-codex': { reasoning: true, temperature: false, promptCacheRetention24h: false },
};

const DEFAULT_GPT5_CAPABILITIES: OpenAIModelCapabilities = {
  reasoning: true,
  temperature: false,
  promptCacheRetention24h: true,
};

const DEFAULT_O_SERIES_CAPABILITIES: OpenAIModelCapabilities = {
  reasoning: true,
  temperature: false,
  promptCacheRetention24h: false,
};

const DEFAULT_GPT4_CAPABILITIES: OpenAIModelCapabilities = {
  reasoning: false,
  temperature: true,
  promptCacheRetention24h: false,
};

export function openaiCapabilitiesForModel(model: string): OpenAIModelCapabilities {
  const exact = OPENAI_MODEL_CAPABILITIES[model];
  if (exact) return exact;
  if (/^o\d/.test(model)) return DEFAULT_O_SERIES_CAPABILITIES;
  if (/^gpt-5/.test(model) || /codex/.test(model)) return DEFAULT_GPT5_CAPABILITIES;
  return DEFAULT_GPT4_CAPABILITIES;
}
