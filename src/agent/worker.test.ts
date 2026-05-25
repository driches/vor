import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget } from '../util/budget.js';
import { BudgetError } from '../util/errors.js';
import { WorkerClient } from './worker.js';

interface FakeAnthropic {
  messages: {
    create: ReturnType<typeof vi.fn>;
  };
}

function makeBudget(): Budget {
  return new Budget({
    maxTurns: 10,
    warnFraction: 0.8,
    maxInputTokens: 100_000,
    maxOutputTokens: 50_000,
  });
}

function mockResponse(textBlocks: Array<{ text: string }>): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: textBlocks.map((b) => ({ type: 'text' as const, text: b.text, citations: [] })) as Anthropic.ContentBlock[],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      service_tier: 'standard',
      server_tool_use: null,
    } as unknown as Anthropic.Message['usage'],
  };
}

describe('WorkerClient', () => {
  it('parses a JSON response and returns the validated shape', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse([{ text: '{"verdict": "confirmed", "confidence": "high"}' }]),
        ),
      },
    };
    const schema = z.object({
      verdict: z.enum(['confirmed', 'refuted']),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      makeBudget(),
      'claude-haiku-4-5',
    );

    const result = await worker.invoke({
      task: 'test',
      systemPrompt: 'system',
      userPrompt: 'user',
      maxTokens: 1024,
      responseSchema: schema,
    });
    expect(result.parsed.verdict).toBe('confirmed');
    expect(result.parsed.confidence).toBe('high');
  });

  it('strips ```json fences (Haiku sometimes adds them)', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse([
            { text: '```json\n{"verdict": "refuted", "confidence": "low"}\n```' },
          ]),
        ),
      },
    };
    const schema = z.object({
      verdict: z.enum(['confirmed', 'refuted']),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      makeBudget(),
    );

    const result = await worker.invoke({
      task: 'test',
      systemPrompt: 'system',
      userPrompt: 'user',
      maxTokens: 1024,
      responseSchema: schema,
    });
    expect(result.parsed.verdict).toBe('refuted');
  });

  it('throws on non-JSON output', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () => mockResponse([{ text: 'I cannot do that' }])),
      },
    };
    const schema = z.object({ verdict: z.string() });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      makeBudget(),
    );

    await expect(
      worker.invoke({
        task: 'test',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 1024,
        responseSchema: schema,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws when JSON does not match the response schema', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse([{ text: '{"verdict": "unknown_value"}' }]),
        ),
      },
    };
    const schema = z.object({
      verdict: z.enum(['confirmed', 'refuted']),
    });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      makeBudget(),
    );

    await expect(
      worker.invoke({
        task: 'test',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 1024,
        responseSchema: schema,
      }),
    ).rejects.toThrow(/schema/);
  });

  it('propagates BudgetError instead of masking it (so the runner can flip to budget_exceeded)', async () => {
    // Budget with a tiny cap that the mocked response will blow past.
    const tightBudget = new Budget({
      maxTurns: 10,
      warnFraction: 0.8,
      maxInputTokens: 50,
      maxOutputTokens: 50,
    });
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse([{ text: '{"verdict": "confirmed", "confidence": "high"}' }]),
        ),
      },
    };
    const schema = z.object({
      verdict: z.enum(['confirmed', 'refuted']),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      tightBudget,
      'claude-haiku-4-5',
    );

    // Mocked response has input_tokens=100 (> cap of 50) → addUsage throws.
    // WorkerClient.invoke must let that BudgetError escape; if it caught
    // and turned it into a normal return, the runner's outer try couldn't
    // trip the budget gate from worker-induced overruns.
    await expect(
      worker.invoke({
        task: 'test',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 1024,
        responseSchema: schema,
      }),
    ).rejects.toBeInstanceOf(BudgetError);
  });

  it('records usage against the shared budget under the worker model id', async () => {
    const budget = makeBudget();
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse([{ text: '{"verdict": "confirmed", "confidence": "high"}' }]),
        ),
      },
    };
    const schema = z.object({
      verdict: z.enum(['confirmed', 'refuted']),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    const worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      budget,
      'claude-haiku-4-5',
    );

    await worker.invoke({
      task: 'test',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 1024,
      responseSchema: schema,
    });

    const perModel = budget.snapshotByModel();
    expect(perModel).toHaveLength(1);
    expect(perModel[0]!.model).toBe('claude-haiku-4-5');
    expect(perModel[0]!.usage.inputTokens).toBe(100);
    expect(perModel[0]!.usage.outputTokens).toBe(50);
  });
});
