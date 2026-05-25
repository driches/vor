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
  it('throws a Task-2 placeholder for Anthropic models until the adapter lands', () => {
    expect(() => createProvider({ modelId: 'claude-sonnet-4-6', apiKey: 'k' })).toThrow(
      /not yet implemented.*Task 2/,
    );
  });

  it('throws a Task-3 placeholder for OpenAI models until the adapter lands', () => {
    expect(() => createProvider({ modelId: 'gpt-4.1', apiKey: 'k' })).toThrow(
      /not yet implemented.*Task 3/,
    );
  });

  it('honors providerHint over model-id inference', () => {
    // claude-* normally infers anthropic; the hint overrides → openai → Task 3 stub
    expect(() =>
      createProvider({ modelId: 'claude-sonnet-4-6', apiKey: 'k', providerHint: 'openai' }),
    ).toThrow(/Task 3/);
  });
});
