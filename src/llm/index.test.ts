import { describe, expect, it } from 'vitest';
import { createProvider, inferProviderFromModel } from './index.js';

describe('inferProviderFromModel', () => {
  it('routes claude-* model ids to Anthropic', () => {
    expect(inferProviderFromModel('claude-sonnet-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('claude-haiku-4-5')).toBe('anthropic');
    expect(inferProviderFromModel('claude-opus-4-7')).toBe('anthropic');
  });

  it('routes gpt-* and chatgpt-* model ids to OpenAI', () => {
    expect(inferProviderFromModel('gpt-4.1')).toBe('openai');
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('gpt-4o-mini')).toBe('openai');
    expect(inferProviderFromModel('chatgpt-4o-latest')).toBe('openai');
  });

  it('routes o-series reasoning models (o1, o3-mini, o4-mini) to OpenAI', () => {
    expect(inferProviderFromModel('o1')).toBe('openai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
    expect(inferProviderFromModel('o4-mini')).toBe('openai');
  });

  it('throws on unknown vendor with a message that mentions the explicit provider knob', () => {
    expect(() => inferProviderFromModel('mistral-large')).toThrow(/provider:/);
    expect(() => inferProviderFromModel('mistral-large')).toThrow(/mistral-large/);
  });
});

describe('createProvider', () => {
  it('returns an AnthropicProvider instance for claude-* model ids', () => {
    const provider = createProvider({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-test' });
    expect(provider.id).toBe('anthropic');
    expect(typeof provider.complete).toBe('function');
    expect(typeof provider.billableInputTokensForBudget).toBe('function');
  });

  it('returns an OpenAIProvider instance for gpt-* and o-series model ids', () => {
    const gpt = createProvider({ modelId: 'gpt-4.1', apiKey: 'sk-test' });
    expect(gpt.id).toBe('openai');
    expect(typeof gpt.complete).toBe('function');
    expect(typeof gpt.billableInputTokensForBudget).toBe('function');

    const oSeries = createProvider({ modelId: 'o4-mini', apiKey: 'sk-test' });
    expect(oSeries.id).toBe('openai');
  });

  it('honors providerHint over model-id inference', () => {
    // claude-* normally infers anthropic; the hint overrides → openai adapter
    const provider = createProvider({
      modelId: 'claude-sonnet-4-6',
      apiKey: 'sk-test',
      providerHint: 'openai',
    });
    expect(provider.id).toBe('openai');
  });
});
