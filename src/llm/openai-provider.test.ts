import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock — openai
//
// `OpenAIProvider`'s constructor `new OpenAI({ apiKey })`s the SDK, so for
// the end-to-end `complete()` test we swap the SDK out with a thin stub
// whose `responses.create` is a spy. Tests that only exercise pure helpers
// don't touch the spy.
const createSpy = vi.fn();
vi.mock('openai', () => {
  class FakeOpenAI {
    public responses = { create: createSpy };
    constructor(_opts: { apiKey: string }) {
      // no-op
    }
  }
  return { default: FakeOpenAI };
});

// Import AFTER vi.mock so the module picks up the fake.
import {
  OpenAIProvider,
  canonicalMessagesToResponsesInput,
  canonicalToolsToResponses,
  isReasoningModel,
  responsesResponseToCanonical,
  supportsTemperature,
} from './openai-provider.js';
import type { CanonicalMessage, CanonicalTool } from './types.js';
import { logger } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Model-shape predicates
// ---------------------------------------------------------------------------

describe('isReasoningModel', () => {
  it('returns true for o-series (o1, o3, o3-mini, o4-mini)', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('returns false for gpt-* and chatgpt-*', () => {
    expect(isReasoningModel('gpt-4.1')).toBe(false);
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isReasoningModel('chatgpt-4o-latest')).toBe(false);
  });
});

describe('supportsTemperature', () => {
  it('is the inverse of isReasoningModel — reasoning models reject temperature', () => {
    expect(supportsTemperature('o1')).toBe(false);
    expect(supportsTemperature('o3-mini')).toBe(false);
    expect(supportsTemperature('o4-mini')).toBe(false);
    expect(supportsTemperature('gpt-4.1')).toBe(true);
    expect(supportsTemperature('gpt-4o')).toBe(true);
    expect(supportsTemperature('chatgpt-4o-latest')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalMessagesToResponsesInput
// ---------------------------------------------------------------------------

describe('canonicalMessagesToResponsesInput', () => {
  it('converts a user message into a message item with one input_text block', () => {
    const result = canonicalMessagesToResponsesInput([
      { role: 'user', content: 'review this PR' },
    ]);
    expect(result).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'review this PR' }],
      },
    ]);
  });

  it('converts an assistant text-only message (no provider_state) into a string-content message', () => {
    // EasyInputMessage.content accepts a plain string for assistant role.
    // We deliberately do NOT emit `output_text` blocks here — those are only
    // valid in API RESPONSES, not request input. (Real assistant turns come
    // back from the API with provider_state set; this branch is for
    // synthesized/seed fixtures only.)
    const result = canonicalMessagesToResponsesInput([
      { role: 'assistant', text: 'Got it.' },
    ]);
    expect(result).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Got it.',
      },
    ]);
  });

  it('skips an empty/undefined text block entirely (no zero-length output_text)', () => {
    const fromEmpty = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        text: '',
        tool_calls: [{ id: 't1', name: 'x', arguments: {} }],
      },
    ]);
    // Only the function_call should be emitted — no empty output_text.
    expect(fromEmpty).toHaveLength(1);
    expect(fromEmpty[0]).toMatchObject({ type: 'function_call' });

    const fromUndef = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        tool_calls: [{ id: 't1', name: 'x', arguments: {} }],
      },
    ]);
    expect(fromUndef).toHaveLength(1);
    expect(fromUndef[0]).toMatchObject({ type: 'function_call' });
  });

  it('emits one function_call item per tool_call (no provider_state)', () => {
    const result = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        text: 'Pulling the diff now.',
        tool_calls: [
          { id: 't1', name: 'get_pr_diff', arguments: { full: true } },
          { id: 't2', name: 'list_changed_files', arguments: {} },
        ],
      },
    ]);
    // 1 string-content message + 2 function_call items.
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: 'Pulling the diff now.',
    });
    expect(result[1]).toEqual({
      type: 'function_call',
      call_id: 't1',
      name: 'get_pr_diff',
      arguments: JSON.stringify({ full: true }),
    });
    expect(result[2]).toEqual({
      type: 'function_call',
      call_id: 't2',
      name: 'list_changed_files',
      arguments: JSON.stringify({}),
    });
  });

  it('splats provider_state (array) verbatim and ignores text/tool_calls on that message', () => {
    const priorOutput: unknown[] = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'go', annotations: [] }] },
      { type: 'function_call', call_id: 't1', name: 'x', arguments: '{}' },
    ];
    const result = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        // These should be IGNORED because provider_state is authoritative.
        text: 'IGNORED',
        tool_calls: [{ id: 'IGNORED', name: 'IGNORED', arguments: {} }],
        provider_state: priorOutput,
      },
    ]);
    expect(result).toEqual(priorOutput);
  });

  it('falls back to the no-provider-state branch when provider_state is a non-array (defensive)', () => {
    const result = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        text: 'hello',
        provider_state: { not: 'an array' },
      },
    ]);
    expect(result).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'hello',
      },
    ]);
  });

  it('rejects the splat path when provider_state items are NOT OpenAI-shaped (cross-provider defense)', () => {
    // Simulates a future Anthropic-style payload (no `type: 'message' |
    // 'function_call' | ...` discriminator) being stashed into provider_state.
    // We must NOT forward those items as Responses API input — they would 400
    // or silently corrupt the turn. The synthesized branch fires instead.
    const anthropicShapedPayload: unknown[] = [
      { role: 'foo', content: 'bar' },
      { id: 'block_1', text: 'looks like Anthropic' },
    ];
    const result = canonicalMessagesToResponsesInput([
      {
        role: 'assistant',
        text: 'falls back to synthesized',
        provider_state: anthropicShapedPayload,
      },
    ]);
    expect(result).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'falls back to synthesized',
      },
    ]);
  });

  it('accepts an empty-array provider_state and emits NOTHING for the turn (text is NOT synthesized)', () => {
    // Empty `output` from the prior turn is rare but legal — the model
    // produced no content. The splat path is taken (Array.isArray AND
    // isOpenAIResponseOutput both pass on []) and the assistant turn
    // contributes zero items. text/tool_calls on the same canonical
    // message are still IGNORED per the provider_state-is-authoritative
    // contract.
    const result = canonicalMessagesToResponsesInput([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        text: 'IGNORED — provider_state is authoritative even when empty',
        tool_calls: [{ id: 'IGNORED', name: 'IGNORED', arguments: {} }],
        provider_state: [],
      },
      { role: 'user', content: 'still here?' },
    ]);
    // 2 user messages, 0 contributions from the assistant turn.
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(result[1]).toMatchObject({ type: 'message', role: 'user' });
    // No assistant-shape items at all.
    for (const item of result) {
      expect(item).not.toMatchObject({ role: 'assistant' });
    }
  });

  it('converts a tool message into a function_call_output input item', () => {
    const result = canonicalMessagesToResponsesInput([
      { role: 'tool', tool_call_id: 't1', content: 'diff text' },
    ]);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 't1', output: 'diff text' },
    ]);
  });

  it('emits adjacent tool messages as SEPARATE function_call_output items (no Anthropic-style grouping)', () => {
    const result = canonicalMessagesToResponsesInput([
      { role: 'tool', tool_call_id: 't1', content: 'first' },
      { role: 'tool', tool_call_id: 't2', content: 'second' },
      { role: 'tool', tool_call_id: 't3', content: 'third' },
    ]);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 't1', output: 'first' },
      { type: 'function_call_output', call_id: 't2', output: 'second' },
      { type: 'function_call_output', call_id: 't3', output: 'third' },
    ]);
  });

  it('handles a multi-turn conversation end-to-end with provider_state replay', () => {
    const priorOutput: unknown[] = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'X' },
      { type: 'function_call', call_id: 't1', name: 'get_pr_diff', arguments: '{}' },
    ];
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'review' },
      {
        role: 'assistant',
        provider_state: priorOutput,
      },
      { role: 'tool', tool_call_id: 't1', content: '<diff>' },
    ];
    const result = canonicalMessagesToResponsesInput(messages);
    // user message + 2 splatted items + 1 tool result = 4
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(result[1]).toBe(priorOutput[0]);
    expect(result[2]).toBe(priorOutput[1]);
    expect(result[3]).toEqual({
      type: 'function_call_output',
      call_id: 't1',
      output: '<diff>',
    });
  });
});

// ---------------------------------------------------------------------------
// canonicalToolsToResponses
// ---------------------------------------------------------------------------

describe('canonicalToolsToResponses', () => {
  it('returns an empty array for an empty input', () => {
    expect(canonicalToolsToResponses([])).toEqual([]);
  });

  it('returns flat FunctionTool shape (no nested {function: {…}} wrapper)', () => {
    const tool: CanonicalTool = {
      name: 'echo',
      description: 'returns its input',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    };
    const [out] = canonicalToolsToResponses([tool]);
    expect(out).toEqual({
      type: 'function',
      name: 'echo',
      description: 'returns its input',
      parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      strict: false,
    });
  });

  it('sets strict: false on every tool (our Zod schemas use additionalProperties: true)', () => {
    const tools: CanonicalTool[] = [
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', input_schema: { type: 'object', properties: {} } },
      { name: 'c', description: 'C', input_schema: { type: 'object', properties: {} } },
    ];
    const result = canonicalToolsToResponses(tools);
    for (const t of result) {
      expect(t.strict).toBe(false);
    }
  });

  it('does not attach any cache_control field (Responses API auto-caches)', () => {
    const tools: CanonicalTool[] = [
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', input_schema: { type: 'object', properties: {} } },
    ];
    for (const t of canonicalToolsToResponses(tools)) {
      expect(t).not.toHaveProperty('cache_control');
    }
  });
});

// ---------------------------------------------------------------------------
// responsesResponseToCanonical
// ---------------------------------------------------------------------------

/**
 * Builds a Response with sensible defaults so each test only specifies the
 * fields that matter to it. The SDK's Response type has ~20 required fields
 * most of which are noise here, so we cast the partial through `unknown`.
 */
function fakeResponse(overrides: Partial<OpenAI.Responses.Response>): OpenAI.Responses.Response {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-4.1',
    output: [],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  } as unknown as OpenAI.Responses.Response;
}

describe('responsesResponseToCanonical', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // logger.warn (not console.warn) — the provider routes warnings through
    // the project logger (which adds @actions/core CI annotations + secret
    // redaction). Spying here lets us assert the warning was emitted without
    // touching real CI output.
    warnSpy = vi.spyOn(logger, 'warn').mockResolvedValue(undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('extracts text from an output_text message and reports end_turn', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Hi there.', annotations: [] }],
          },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('Hi there.');
    expect(result.tool_calls).toEqual([]);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('concatenates multiple output_text blocks in order', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'one ', annotations: [] },
              { type: 'output_text', text: 'two', annotations: [] },
            ],
          },
        ],
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('one two');
  });

  it('extracts function_call items into tool_calls and maps stop_reason → tool_calls', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'function_call',
            call_id: 't1',
            name: 'get_pr_diff',
            arguments: '{"ref":"HEAD"}',
          },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('');
    expect(result.tool_calls).toEqual([
      { id: 't1', name: 'get_pr_diff', arguments: { ref: 'HEAD' } },
    ]);
    expect(result.stop_reason).toBe('tool_calls');
  });

  it('populates both text and tool_calls when both are present', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Now calling tool.', annotations: [] }],
          },
          { type: 'function_call', call_id: 't1', name: 'x', arguments: '{}' },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('Now calling tool.');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.stop_reason).toBe('tool_calls');
  });

  it('treats refusal as [refused]-prefixed text and forces stop_reason end_turn', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
          },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('[refused] I cannot help with that.');
    expect(result.stop_reason).toBe('end_turn');
  });

  it('discards an output_text preamble that precedes a refusal in the same message (PR #20 self-review #3300641271)', async () => {
    // If a model emits [output_text("Sure, let me..."), refusal("Actually I can't")],
    // the refusal is authoritative — surfacing "Sure, let me...[refused] Actually
    // I can't" in canonical text would be confusing for the runner's logs.
    // Refusal text becomes the only visible content.
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'Sure, let me check…' },
              { type: 'refusal', refusal: 'Actually I cannot help with that.' },
              { type: 'output_text', text: 'trailing text should also be dropped' },
            ],
          },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('[refused] Actually I cannot help with that.');
    expect(result.stop_reason).toBe('end_turn');
  });

  it('does NOT surface reasoning items in canonical text', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: [
          {
            type: 'reasoning',
            id: 'r1',
            summary: [{ type: 'summary_text', text: 'thinking...' }],
            encrypted_content: 'OPAQUE',
          },
          {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'visible reply', annotations: [] }],
          },
        ],
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.text).toBe('visible reply');
    // But the reasoning item IS preserved in provider_state for replay.
    expect(Array.isArray(result.provider_state)).toBe(true);
    expect((result.provider_state as unknown[])[0]).toMatchObject({ type: 'reasoning' });
  });

  it('surfaces a tool_call with empty args and emits logger.warn on malformed JSON', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        model: 'gpt-4.1',
        output: [
          {
            type: 'function_call',
            call_id: 't1',
            name: 'broken_tool',
            arguments: 'not valid json{{{',
          },
        ],
        status: 'completed',
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.tool_calls).toEqual([
      { id: 't1', name: 'broken_tool', arguments: {} },
    ]);
    expect(result.stop_reason).toBe('tool_calls');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = warnSpy.mock.calls[0]![0] as string;
    expect(warnMessage).toContain('gpt-4.1');
    expect(warnMessage).toContain('broken_tool');
  });

  it('maps incomplete + max_output_tokens to stop_reason max_tokens', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('maps incomplete + content_filter (or any other reason) to stop_reason other', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.stop_reason).toBe('other');
  });

  it('maps non-completed, non-incomplete statuses (e.g. failed/in_progress) to stop_reason other', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({ status: 'failed' } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.stop_reason).toBe('other');
  });

  it('maps usage input_tokens / output_tokens and leaves cache fields undefined when 0', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.usage.cache_read_tokens).toBeUndefined();
    expect(result.usage.reasoning_tokens).toBeUndefined();
    expect(result.usage.cache_creation_tokens).toBeUndefined();
  });

  it('surfaces cache_read_tokens (from input_tokens_details.cached_tokens) when > 0', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          total_tokens: 1050,
          input_tokens_details: { cached_tokens: 600 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.usage.cache_read_tokens).toBe(600);
  });

  it('surfaces reasoning_tokens (from output_tokens_details.reasoning_tokens) when > 0', async () => {
    const result = responsesResponseToCanonical(
      fakeResponse({
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          total_tokens: 300,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 150 },
        },
      } as unknown as Partial<OpenAI.Responses.Response>),
    );
    expect(result.usage.reasoning_tokens).toBe(150);
    // cache_creation_tokens is intentionally never set for OpenAI (no
    // creation cost surfaced by the API).
    expect(result.usage.cache_creation_tokens).toBeUndefined();
  });

  it('sets provider_state to the full response.output array (for replay)', async () => {
    const output: unknown[] = [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'X' },
      { type: 'function_call', call_id: 't1', name: 'x', arguments: '{}' },
    ];
    const result = responsesResponseToCanonical(
      fakeResponse({
        output: output as unknown as OpenAI.Responses.Response['output'],
      }),
    );
    expect(result.provider_state).toBe(output);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider (class adapter, with mocked SDK)
// ---------------------------------------------------------------------------

describe('OpenAIProvider', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });
  afterEach(() => {
    createSpy.mockReset();
  });

  it('has id === "openai"', () => {
    expect(new OpenAIProvider('sk-test').id).toBe('openai');
  });

  describe('billableInputTokensForBudget', () => {
    const provider = new OpenAIProvider('sk-test');

    it('subtracts cache_read_tokens from input_tokens (PR #13 budget semantics)', () => {
      expect(
        provider.billableInputTokensForBudget({
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_tokens: 600,
        }),
      ).toBe(400);
    });

    it('returns input_tokens unchanged when cache_read_tokens is missing', () => {
      expect(
        provider.billableInputTokensForBudget({
          input_tokens: 1000,
          output_tokens: 50,
        }),
      ).toBe(1000);
    });
  });

  describe('complete()', () => {
    function emptyCompletedResponse(model = 'gpt-4.1'): OpenAI.Responses.Response {
      return fakeResponse({
        model: model as unknown as OpenAI.Responses.Response['model'],
        output: [],
        status: 'completed',
      });
    }

    it('non-reasoning model: sends temperature, omits include, store: false, flat tool shape', async () => {
      createSpy.mockResolvedValueOnce(emptyCompletedResponse('gpt-4.1'));

      const provider = new OpenAIProvider('sk-test');
      const tools: CanonicalTool[] = [
        {
          name: 'get_pr_diff',
          description: 'fetch the PR diff',
          input_schema: { type: 'object', properties: {} },
        },
      ];

      await provider.complete([{ role: 'user', content: 'review this' }], tools, {
        model: 'gpt-4.1',
        maxOutputTokens: 4096,
        system: 'You are a reviewer.',
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      const [body] = createSpy.mock.calls[0]!;
      expect(body.model).toBe('gpt-4.1');
      expect(body.max_output_tokens).toBe(4096);
      expect(body.instructions).toBe('You are a reviewer.');
      expect(body.store).toBe(false);
      expect(body.temperature).toBe(0.5); // default from CompleteOptions
      expect(body).not.toHaveProperty('include');

      // Input: one user message.
      expect(body.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'review this' }],
        },
      ]);

      // Tools: flat FunctionTool shape.
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toEqual({
        type: 'function',
        name: 'get_pr_diff',
        description: 'fetch the PR diff',
        parameters: { type: 'object', properties: {} },
        strict: false,
      });
    });

    it('reasoning model (o4-mini): omits temperature, sends include for encrypted reasoning, store: false', async () => {
      createSpy.mockResolvedValueOnce(emptyCompletedResponse('o4-mini'));

      await new OpenAIProvider('sk-test').complete([], [], {
        model: 'o4-mini',
        maxOutputTokens: 4096,
        system: 's',
      });

      const [body] = createSpy.mock.calls[0]!;
      expect(body.model).toBe('o4-mini');
      expect(body).not.toHaveProperty('temperature');
      expect(body.store).toBe(false);
      expect(body.include).toEqual(['reasoning.encrypted_content']);
    });

    it('honors a provided temperature override on non-reasoning models', async () => {
      createSpy.mockResolvedValueOnce(emptyCompletedResponse('gpt-4o'));
      await new OpenAIProvider('sk-test').complete([], [], {
        model: 'gpt-4o',
        maxOutputTokens: 100,
        system: 's',
        temperature: 0.2,
      });
      expect(createSpy.mock.calls[0]![0].temperature).toBe(0.2);
    });

    it('passes abortSignal through to the SDK request opts', async () => {
      createSpy.mockResolvedValueOnce(emptyCompletedResponse('gpt-4.1'));
      const controller = new AbortController();
      await new OpenAIProvider('sk-test').complete([], [], {
        model: 'gpt-4.1',
        maxOutputTokens: 100,
        system: 's',
        abortSignal: controller.signal,
      });
      expect(createSpy.mock.calls[0]![1]).toEqual({ signal: controller.signal });
    });

    it('returns a canonical response built from the SDK response', async () => {
      createSpy.mockResolvedValueOnce(
        fakeResponse({
          output: [
            {
              type: 'message',
              id: 'm1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Reviewing.', annotations: [] }],
            },
            { type: 'function_call', call_id: 't1', name: 'get_pr_diff', arguments: '{}' },
          ],
          status: 'completed',
          usage: {
            input_tokens: 200,
            output_tokens: 75,
            total_tokens: 275,
            input_tokens_details: { cached_tokens: 50 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        } as unknown as Partial<OpenAI.Responses.Response>),
      );

      const result = await new OpenAIProvider('sk-test').complete(
        [{ role: 'user', content: 'review this' }],
        [],
        { model: 'gpt-4.1', maxOutputTokens: 4096, system: 'sys' },
      );

      expect(result.text).toBe('Reviewing.');
      expect(result.tool_calls).toEqual([
        { id: 't1', name: 'get_pr_diff', arguments: {} },
      ]);
      expect(result.stop_reason).toBe('tool_calls');
      expect(result.usage).toEqual({
        input_tokens: 200,
        output_tokens: 75,
        cache_read_tokens: 50,
      });
      expect(Array.isArray(result.provider_state)).toBe(true);
    });
  });
});
