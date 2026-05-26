import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { Budget } from '../util/budget.js';
import { BudgetError } from '../util/errors.js';
import { WorkerClient } from '../agent/worker.js';
import { hasReadRange } from '../agent/run-context.js';
import { makeWorkerSummarizeFileTool } from './worker-summarize-file.js';
import { buildFakeDeps, callTool, getResultJson } from './test-helpers.js';

interface FakeAnthropic {
  messages: { create: ReturnType<typeof vi.fn> };
}

function mockWorkerResponse(jsonText: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text' as const, text: jsonText, citations: [] }] as Anthropic.ContentBlock[],
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

function makeWorker(client: FakeAnthropic): WorkerClient {
  const budget = new Budget({
    maxTurns: 10,
    warnFraction: 0.8,
    maxInputTokens: 100_000,
    maxOutputTokens: 50_000,
  });
  return new WorkerClient(
    client as unknown as Anthropic,
    budget,
    'claude-haiku-4-5',
  );
}

const VALID_SUMMARY = JSON.stringify({
  summary: 'Exports authenticate(req, res) at line 12 — validates a Bearer token.',
  focused_answer: 'No error handling on db.users.findById (line 28).',
  flags_for_deeper_look: [
    { line: 28, concern: 'Awaited db call has no try/catch — 500 on transient DB failure.' },
  ],
  total_lines: 40,
  reviewed_range: [1, 40],
});

describe('worker_summarize_file', () => {
  it('returns ok=false when worker delegation is disabled', async () => {
    const deps = buildFakeDeps(); // no worker
    const tool = makeWorkerSummarizeFileTool(deps);

    const result = await callTool(tool, {
      path: 'src/foo.ts',
      focus_question: 'What does this file do?',
    });
    const json = getResultJson(result) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/not enabled/);
  });

  it('returns ok=false when the file is not found', async () => {
    const fakeClient: FakeAnthropic = { messages: { create: vi.fn() } };
    const deps = buildFakeDeps({
      fileReader: {
        read: async () => null,
        readRange: async () => null,
      },
    });
    deps.worker = makeWorker(fakeClient);
    const tool = makeWorkerSummarizeFileTool(deps);

    const result = await callTool(tool, {
      path: 'src/missing.ts',
      focus_question: 'What does this file do?',
    });
    const json = getResultJson(result) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/not found/);
    // Worker must not be called when the file read fails.
    expect(fakeClient.messages.create).not.toHaveBeenCalled();
  });

  it('returns a structured summary on the happy path', async () => {
    const fakeClient: FakeAnthropic = {
      messages: { create: vi.fn(async () => mockWorkerResponse(VALID_SUMMARY)) },
    };
    const deps = buildFakeDeps({
      fileReader: {
        read: async () => null,
        readRange: async () => ({
          content: 'export function authenticate() { /* ... */ }',
          total_lines: 40,
          returned_range: [1, 40] as [number, number],
          truncated: false,
        }),
      },
    });
    deps.worker = makeWorker(fakeClient);
    const tool = makeWorkerSummarizeFileTool(deps);

    const result = await callTool(tool, {
      path: 'src/auth.ts',
      focus_question: 'Is there error handling on the db call?',
    });
    const json = getResultJson(result) as {
      ok: boolean;
      summary: string;
      focused_answer: string;
      flags_for_deeper_look: Array<{ line: number; concern: string }>;
      reminder: string;
    };
    expect(json.ok).toBe(true);
    expect(json.summary).toMatch(/authenticate/);
    expect(json.focused_answer).toMatch(/No error handling/);
    expect(json.flags_for_deeper_look).toHaveLength(1);
    expect(json.flags_for_deeper_look[0]!.line).toBe(28);
    expect(json.reminder).toMatch(/hint, not evidence/);
  });

  it('does NOT record a head read (worker output is not verification)', async () => {
    // Critical invariant: validate-comment.ts requires Sonnet to call
    // read_file_at_ref before posting critical/important findings. If
    // worker_summarize_file accidentally recorded a head read, Sonnet could
    // post a finding based purely on Haiku's summary — exactly the failure
    // mode the validator is designed to prevent.
    const fakeClient: FakeAnthropic = {
      messages: { create: vi.fn(async () => mockWorkerResponse(VALID_SUMMARY)) },
    };
    const deps = buildFakeDeps({
      fileReader: {
        read: async () => null,
        readRange: async () => ({
          content: 'export function authenticate() { /* ... */ }',
          total_lines: 40,
          returned_range: [1, 40] as [number, number],
          truncated: false,
        }),
      },
    });
    deps.worker = makeWorker(fakeClient);
    const tool = makeWorkerSummarizeFileTool(deps);

    await callTool(tool, {
      path: 'src/auth.ts',
      focus_question: 'Is there error handling on the db call?',
    });

    // The validator looks up by path + line. After a worker summary, no line
    // in the file should be considered "read" — Sonnet still has to call
    // read_file_at_ref before posting.
    expect(hasReadRange(deps.runContext, 'src/auth.ts', 1)).toBe(false);
    expect(hasReadRange(deps.runContext, 'src/auth.ts', 28)).toBe(false);
    expect(hasReadRange(deps.runContext, 'src/auth.ts', 40)).toBe(false);
  });

  it('falls back to ok=false hint on non-budget worker errors', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('haiku timeout');
        }),
      },
    };
    const deps = buildFakeDeps({
      fileReader: {
        read: async () => null,
        readRange: async () => ({
          content: 'foo',
          total_lines: 1,
          returned_range: [1, 1] as [number, number],
          truncated: false,
        }),
      },
    });
    deps.worker = makeWorker(fakeClient);
    const tool = makeWorkerSummarizeFileTool(deps);

    const result = await callTool(tool, {
      path: 'src/foo.ts',
      focus_question: 'tell me about this',
    });
    const json = getResultJson(result) as { ok: boolean; error?: string; hint?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/worker summarize failed/);
    expect(json.hint).toMatch(/read_file_at_ref/);
  });

  it('lets BudgetError escape so the runner can flip to budget_exceeded', async () => {
    // Tight budget so the worker's usage tracking trips immediately.
    const tightBudget = new Budget({
      maxTurns: 10,
      warnFraction: 0.8,
      maxInputTokens: 50, // mocked usage is 100, exceeds cap
      maxOutputTokens: 50,
    });
    const fakeClient: FakeAnthropic = {
      messages: { create: vi.fn(async () => mockWorkerResponse(VALID_SUMMARY)) },
    };
    const deps = buildFakeDeps({
      fileReader: {
        read: async () => null,
        readRange: async () => ({
          content: 'foo',
          total_lines: 1,
          returned_range: [1, 1] as [number, number],
          truncated: false,
        }),
      },
    });
    deps.worker = new WorkerClient(
      fakeClient as unknown as Anthropic,
      tightBudget,
      'claude-haiku-4-5',
    );
    const tool = makeWorkerSummarizeFileTool(deps);

    await expect(
      callTool(tool, {
        path: 'src/foo.ts',
        focus_question: 'tell me about this',
      }),
    ).rejects.toBeInstanceOf(BudgetError);
  });
});
