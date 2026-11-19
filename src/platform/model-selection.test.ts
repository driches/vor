import { describe, expect, it } from 'vitest';
import { assertValidProviderOverride, resolveModelSelection } from './model-selection.js';

describe('resolveModelSelection', () => {
  it('uses GPT-5.6 Sol when OpenAI is explicitly selected without another model', () => {
    expect(
      resolveModelSelection({
        model: 'claude-sonnet-4-6',
        providerPreference: 'openai',
        hasAnthropicKey: true,
        hasOpenAIKey: true,
      }),
    ).toEqual({ model: 'gpt-5.6-sol', provider: 'openai' });
  });

  it('uses GPT-5.6 Sol when OpenAI is the only configured key', () => {
    expect(
      resolveModelSelection({
        model: 'claude-sonnet-4-6',
        hasAnthropicKey: false,
        hasOpenAIKey: true,
      }),
    ).toEqual({ model: 'gpt-5.6-sol', provider: 'openai' });
  });

  it('preserves the Claude default for Anthropic and dual-key setups', () => {
    expect(
      resolveModelSelection({
        model: 'claude-sonnet-4-6',
        hasAnthropicKey: true,
        hasOpenAIKey: true,
      }),
    ).toEqual({ model: 'claude-sonnet-4-6', provider: 'anthropic' });
  });

  it('preserves an explicitly selected OpenAI model', () => {
    expect(
      resolveModelSelection({
        model: 'gpt-4.1',
        hasAnthropicKey: false,
        hasOpenAIKey: true,
      }),
    ).toEqual({ model: 'gpt-4.1', provider: 'openai' });
  });
});

describe('assertValidProviderOverride', () => {
  it('accepts known providers and rejects unknown runtime strings', () => {
    expect(() => assertValidProviderOverride(undefined)).not.toThrow();
    expect(() => assertValidProviderOverride('anthropic')).not.toThrow();
    expect(() => assertValidProviderOverride('openai')).not.toThrow();
    expect(() => assertValidProviderOverride('open-ai')).toThrow(
      'Invalid provider_override "open-ai"',
    );
  });
});
