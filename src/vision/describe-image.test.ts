/**
 * Tests for the vision describe-image module: AnthropicVisionClient builds a
 * base64 image block, records usage against the Budget, and degrades to an
 * empty description on error; mediaTypeForPath maps extensions.
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { Budget } from '../util/budget.js';
import { AnthropicVisionClient, mediaTypeForPath, type Logger } from './describe-image.js';

function makeBudget(): Budget {
  return new Budget({ maxTurns: 10, warnFraction: 0.8, maxInputTokens: 1e6, maxOutputTokens: 1e6 });
}

function makeLogger(): Logger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  };
}

const USAGE = { input_tokens: 120, output_tokens: 30 } as Anthropic.Message['usage'];

describe('AnthropicVisionClient.describe', () => {
  it('sends a base64 image block and returns the model description', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'A login form showing an API key field.' }],
      usage: USAGE,
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const budget = makeBudget();
    const vision = new AnthropicVisionClient(client, budget, 'claude-haiku-4-5', makeLogger());

    const out = await vision.describe(Buffer.from('PNGDATA'), 'image/png');

    expect(out.description).toBe('A login form showing an API key field.');
    const call = create.mock.calls[0]![0];
    expect(call.model).toBe('claude-haiku-4-5');
    const block = call.messages[0].content[0];
    expect(block.type).toBe('image');
    expect(block.source).toMatchObject({
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from('PNGDATA').toString('base64'),
    });
    // Usage rolled into the budget.
    expect(budget.snapshotByModel().find((m) => m.model === 'claude-haiku-4-5')).toBeDefined();
  });

  it('returns an empty description (never throws) on API error', async () => {
    const create = vi.fn().mockRejectedValue(new Error('overloaded'));
    const client = { messages: { create } } as unknown as Anthropic;
    const vision = new AnthropicVisionClient(
      client,
      makeBudget(),
      'claude-haiku-4-5',
      makeLogger(),
    );
    const out = await vision.describe(Buffer.from('x'), 'image/png');
    expect(out.description).toBe('');
  });

  it('propagates a BudgetError (does not swallow it as a vision failure)', async () => {
    // The API call succeeded, but recording its usage pushes the run over the
    // input cap — addUsage throws and the error must propagate to halt the run.
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 1 },
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const tightBudget = new Budget({
      maxTurns: 10,
      warnFraction: 0.8,
      maxInputTokens: 50,
      maxOutputTokens: 1e6,
    });
    const vision = new AnthropicVisionClient(client, tightBudget, 'claude-haiku-4-5', makeLogger());
    await expect(vision.describe(Buffer.from('x'), 'image/png')).rejects.toThrow(/maxInputTokens/);
  });
});

describe('mediaTypeForPath', () => {
  it('maps supported extensions and rejects others', () => {
    expect(mediaTypeForPath('a/b.png')).toBe('image/png');
    expect(mediaTypeForPath('X.JPEG')).toBe('image/jpeg');
    expect(mediaTypeForPath('x.jpg')).toBe('image/jpeg');
    expect(mediaTypeForPath('x.gif')).toBe('image/gif');
    expect(mediaTypeForPath('x.webp')).toBe('image/webp');
    expect(mediaTypeForPath('x.bmp')).toBeUndefined();
    expect(mediaTypeForPath('x.txt')).toBeUndefined();
  });
});
