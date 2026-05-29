import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock — @anthropic-ai/sdk
//
// `AnthropicProvider`'s constructor `new Anthropic({ apiKey })`s the SDK, so
// for the end-to-end `complete()` test we swap the SDK out with a thin stub
// whose `messages.create` is a spy. Tests that only exercise pure helpers
// don't touch the spy.
const createSpy = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: createSpy };
    constructor(_opts: { apiKey: string }) {
      // no-op
    }
  }
  return { default: FakeAnthropic };
});

// Import AFTER vi.mock so the module picks up the fake.
import {
  AnthropicProvider,
  SAFE_NON_STREAMING_MAX_TOKENS,
  anthropicResponseToCanonical,
  canonicalMessagesToAnthropic,
  canonicalToolsToAnthropic,
  markLastBlockForCaching,
  markLatestMessageForCaching,
} from './anthropic-provider.js';
import type { CanonicalMessage, CanonicalTool } from './types.js';

// ---------------------------------------------------------------------------
// markLatestMessageForCaching (moved from src/agent/runner.test.ts)
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;

function hasCache(block: unknown): boolean {
  return block !== null && typeof block === 'object' && 'cache_control' in (block as Block);
}

function userResults(blocks: Block[]): Anthropic.MessageParam {
  return { role: 'user', content: blocks as unknown as Anthropic.MessageParam['content'] };
}

function assistant(blocks: Block[]): Anthropic.MessageParam {
  return { role: 'assistant', content: blocks as unknown as Anthropic.MessageParam['content'] };
}

function toolResult(id: string, text: string): Block {
  return { type: 'tool_result', tool_use_id: id, content: text };
}

describe('markLatestMessageForCaching', () => {
  it('is a no-op when the messages array is empty', () => {
    const messages: Anthropic.MessageParam[] = [];
    expect(() => markLatestMessageForCaching(messages)).not.toThrow();
    expect(messages).toEqual([]);
  });

  it('is a no-op when only string-content user messages exist (turn 1, before any tool_results)', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'initial user prompt' }];
    markLatestMessageForCaching(messages);
    expect(messages[0]!.content).toBe('initial user prompt');
  });

  it('marks the only array-content user message when one exists (turn 2: 1 message breakpoint)', () => {
    const tr = toolResult('t1', 'diff output');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'tool_use', id: 't1', name: 'get_pr_diff', input: {} }]),
      userResults([tr]),
    ];
    markLatestMessageForCaching(messages);
    expect(hasCache(tr)).toBe(true);
  });

  it('marks both the latest two array-content user messages (turn 3+: 2 message breakpoints)', () => {
    const tr1 = toolResult('t1', 'first');
    const tr2 = toolResult('t2', 'second');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'tool_use', id: 't1', name: 'a', input: {} }]),
      userResults([tr1]),
      assistant([{ type: 'tool_use', id: 't2', name: 'b', input: {} }]),
      userResults([tr2]),
    ];
    markLatestMessageForCaching(messages);
    expect(hasCache(tr1)).toBe(true);
    expect(hasCache(tr2)).toBe(true);
  });

  it('marks the last block of multi-block user messages, not earlier ones', () => {
    const first = toolResult('a', 'first block');
    const last = toolResult('b', 'last block');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'text', text: 'doing two things' }]),
      userResults([first, last]),
    ];
    markLatestMessageForCaching(messages);
    expect(hasCache(first)).toBe(false);
    expect(hasCache(last)).toBe(true);
  });

  it('marks only the last block of EACH kept message when both have multi-block content', () => {
    const prevFirst = toolResult('p1', 'prev first');
    const prevLast = toolResult('p2', 'prev last');
    const curFirst = toolResult('c1', 'cur first');
    const curLast = toolResult('c2', 'cur last');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'text', text: 'prev turn' }]),
      userResults([prevFirst, prevLast]),
      assistant([{ type: 'text', text: 'cur turn' }]),
      userResults([curFirst, curLast]),
    ];
    markLatestMessageForCaching(messages);
    expect(hasCache(prevFirst)).toBe(false);
    expect(hasCache(prevLast)).toBe(true);
    expect(hasCache(curFirst)).toBe(false);
    expect(hasCache(curLast)).toBe(true);
  });

  it('strips cache_control from out-of-window (older than latest two) user messages', () => {
    const tr1 = { ...toolResult('t1', 'first'), cache_control: { type: 'ephemeral' as const } };
    const tr2 = toolResult('t2', 'second');
    const tr3 = toolResult('t3', 'third');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'tool_use', id: 't1', name: 'a', input: {} }]),
      userResults([tr1]),
      assistant([{ type: 'tool_use', id: 't2', name: 'b', input: {} }]),
      userResults([tr2]),
      assistant([{ type: 'tool_use', id: 't3', name: 'c', input: {} }]),
      userResults([tr3]),
    ];
    markLatestMessageForCaching(messages);
    expect(hasCache(tr1)).toBe(false);
    expect(hasCache(tr2)).toBe(true);
    expect(hasCache(tr3)).toBe(true);
  });

  it('does not crash on an empty content array (defensive — last block lookup returns undefined)', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'text', text: 'no tool calls this turn' }]),
      userResults([]),
    ];
    expect(() => markLatestMessageForCaching(messages)).not.toThrow();
  });

  it('is idempotent — running twice produces the same state', () => {
    const tr1 = toolResult('t1', 'first');
    const tr2 = toolResult('t2', 'second');
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial' },
      assistant([{ type: 'tool_use', id: 't1', name: 'a', input: {} }]),
      userResults([tr1]),
      assistant([{ type: 'tool_use', id: 't2', name: 'b', input: {} }]),
      userResults([tr2]),
    ];
    markLatestMessageForCaching(messages);
    const snapshot = JSON.stringify(messages);
    markLatestMessageForCaching(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe('markLastBlockForCaching', () => {
  it('marks the only block in a single-block message', () => {
    const block = toolResult('t1', 'single');
    const msg: Anthropic.MessageParam = userResults([block]);
    markLastBlockForCaching(msg);
    expect(hasCache(block)).toBe(true);
  });

  it('only marks the LAST block when there are multiple', () => {
    const first = toolResult('a', 'first');
    const last = toolResult('b', 'last');
    const msg: Anthropic.MessageParam = userResults([first, last]);
    markLastBlockForCaching(msg);
    expect(hasCache(first)).toBe(false);
    expect(hasCache(last)).toBe(true);
  });

  it('is a no-op for string-content messages', () => {
    const msg: Anthropic.MessageParam = { role: 'user', content: 'plain string' };
    expect(() => markLastBlockForCaching(msg)).not.toThrow();
    expect(msg.content).toBe('plain string');
  });

  it('is a no-op for empty content arrays', () => {
    const msg: Anthropic.MessageParam = userResults([]);
    expect(() => markLastBlockForCaching(msg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// canonicalMessagesToAnthropic
// ---------------------------------------------------------------------------

describe('canonicalMessagesToAnthropic', () => {
  it('round-trips a single string-content user message unchanged', () => {
    const result = canonicalMessagesToAnthropic([{ role: 'user', content: 'review this PR' }]);
    expect(result).toEqual([{ role: 'user', content: 'review this PR' }]);
  });

  it('converts an assistant message with only text into a single text block', () => {
    const result = canonicalMessagesToAnthropic([{ role: 'assistant', text: 'Got it.' }]);
    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] }]);
  });

  it('converts an assistant message with only tool_calls into tool_use blocks', () => {
    const result = canonicalMessagesToAnthropic([
      {
        role: 'assistant',
        tool_calls: [{ id: 't1', name: 'get_pr_diff', arguments: { full: true } }],
      },
    ]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_pr_diff', input: { full: true } }],
      },
    ]);
  });

  it('converts an assistant message with text + tool_calls into a mixed content array (text first)', () => {
    const result = canonicalMessagesToAnthropic([
      {
        role: 'assistant',
        text: 'Pulling the diff now.',
        tool_calls: [{ id: 't1', name: 'get_pr_diff', arguments: {} }],
      },
    ]);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Pulling the diff now.' },
          { type: 'tool_use', id: 't1', name: 'get_pr_diff', input: {} },
        ],
      },
    ]);
  });

  it('drops provider_state — Anthropic has no place to put OpenAI replay blobs', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'assistant', text: 'hi', provider_state: { reasoning: ['secret'] } },
    ]);
    // The resulting MessageParam shape only allows role+content; provider_state
    // is not a field on it. Asserting equality covers this implicitly.
    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('wraps a single tool message in one user message with one tool_result block', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'tool', tool_call_id: 't1', content: 'diff text' },
    ]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'diff text' }],
      },
    ]);
  });

  it('groups consecutive tool messages into a single user message (Anthropic requires it for the same assistant turn)', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'tool', tool_call_id: 't1', content: 'first' },
      { role: 'tool', tool_call_id: 't2', content: 'second' },
      { role: 'tool', tool_call_id: 't3', content: 'third' },
    ]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'first' },
          { type: 'tool_result', tool_use_id: 't2', content: 'second' },
          { type: 'tool_result', tool_use_id: 't3', content: 'third' },
        ],
      },
    ]);
  });

  it('keeps non-adjacent tool message groups in separate user messages (a new assistant turn breaks the run)', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'tool', tool_call_id: 't1', content: 'first' },
      { role: 'assistant', text: 'thinking', tool_calls: [{ id: 't2', name: 'x', arguments: {} }] },
      { role: 'tool', tool_call_id: 't2', content: 'second' },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'first' }],
    });
    expect(result[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: 'second' }],
    });
  });

  it('propagates is_error: true onto the tool_result block', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'tool', tool_call_id: 't1', content: 'oops', is_error: true },
    ]);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'oops', is_error: true }],
    });
  });

  it('omits is_error when undefined or false (avoids polluting payloads)', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'tool', tool_call_id: 't2', content: 'ok', is_error: false },
    ]);
    const userContent = (result[0] as { content: unknown[] }).content;
    expect(userContent[0]).not.toHaveProperty('is_error');
    expect(userContent[1]).not.toHaveProperty('is_error');
  });

  it('does not emit an empty text block when assistant text is undefined or empty', () => {
    const result = canonicalMessagesToAnthropic([
      { role: 'assistant', text: '', tool_calls: [{ id: 't1', name: 'x', arguments: {} }] },
    ]);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
    });
  });

  it('handles a multi-turn conversation end-to-end', () => {
    const input: CanonicalMessage[] = [
      { role: 'user', content: 'review' },
      {
        role: 'assistant',
        text: 'starting',
        tool_calls: [
          { id: 't1', name: 'get_pr_diff', arguments: {} },
          { id: 't2', name: 'list_changed_files', arguments: {} },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '<diff>' },
      { role: 'tool', tool_call_id: 't2', content: '<files>' },
      { role: 'assistant', text: 'done' },
    ];
    const result = canonicalMessagesToAnthropic(input);
    expect(result).toHaveLength(4);
    expect((result[2] as { content: unknown[] }).content).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// canonicalToolsToAnthropic
// ---------------------------------------------------------------------------

describe('canonicalToolsToAnthropic', () => {
  it('returns an empty array for an empty input', () => {
    expect(canonicalToolsToAnthropic([])).toEqual([]);
  });

  it('preserves name, description, and input_schema', () => {
    const tool: CanonicalTool = {
      name: 'echo',
      description: 'returns its input',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    };
    const [out] = canonicalToolsToAnthropic([tool]);
    expect(out!.name).toBe('echo');
    expect(out!.description).toBe('returns its input');
    expect(out!.input_schema).toEqual(tool.input_schema);
  });

  it('marks ONLY the last tool with cache_control (cache breakpoint #3 of 4)', () => {
    const tools: CanonicalTool[] = [
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
      { name: 'b', description: 'B', input_schema: { type: 'object', properties: {} } },
      { name: 'c', description: 'C', input_schema: { type: 'object', properties: {} } },
    ];
    const result = canonicalToolsToAnthropic(tools);
    expect(result[0]).not.toHaveProperty('cache_control');
    expect(result[1]).not.toHaveProperty('cache_control');
    expect(result[2]).toHaveProperty('cache_control', { type: 'ephemeral' });
  });

  it('marks the single tool when there is only one', () => {
    const result = canonicalToolsToAnthropic([
      { name: 'only', description: 'd', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(result[0]).toHaveProperty('cache_control', { type: 'ephemeral' });
  });
});

// ---------------------------------------------------------------------------
// anthropicResponseToCanonical
// ---------------------------------------------------------------------------

function fakeMessage(overrides: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  } as Anthropic.Message;
}

describe('anthropicResponseToCanonical', () => {
  it('extracts text from a text-only response and reports end_turn', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        content: [{ type: 'text', text: 'Hi there.', citations: null }],
        stop_reason: 'end_turn',
      }),
    );
    expect(result.text).toBe('Hi there.');
    expect(result.tool_calls).toEqual([]);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('extracts tool_calls from a tool_use response and maps stop_reason → tool_calls', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        content: [{ type: 'tool_use', id: 't1', name: 'get_pr_diff', input: { ref: 'HEAD' } }],
        stop_reason: 'tool_use',
      }),
    );
    expect(result.text).toBe('');
    expect(result.tool_calls).toEqual([
      { id: 't1', name: 'get_pr_diff', arguments: { ref: 'HEAD' } },
    ]);
    expect(result.stop_reason).toBe('tool_calls');
  });

  it('coerces tool_use input null → empty object', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        content: [{ type: 'tool_use', id: 't1', name: 'noargs', input: null as unknown as object }],
        stop_reason: 'tool_use',
      }),
    );
    expect(result.tool_calls[0]!.arguments).toEqual({});
  });

  it('populates both text and tool_calls when both are present', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        content: [
          { type: 'text', text: 'Now calling tool.', citations: null },
          { type: 'tool_use', id: 't1', name: 'x', input: {} },
        ],
        stop_reason: 'tool_use',
      }),
    );
    expect(result.text).toBe('Now calling tool.');
    expect(result.tool_calls).toHaveLength(1);
  });

  it('concatenates multiple text blocks in order', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        content: [
          { type: 'text', text: 'one ', citations: null },
          { type: 'text', text: 'two', citations: null },
        ],
      }),
    );
    expect(result.text).toBe('one two');
  });

  it('maps max_tokens stop_reason through unchanged', () => {
    const result = anthropicResponseToCanonical(fakeMessage({ stop_reason: 'max_tokens' }));
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('collapses unknown stop_reason values (stop_sequence) onto "other"', () => {
    const result = anthropicResponseToCanonical(fakeMessage({ stop_reason: 'stop_sequence' }));
    expect(result.stop_reason).toBe('other');
  });

  it('collapses a null stop_reason onto "other"', () => {
    const result = anthropicResponseToCanonical(fakeMessage({ stop_reason: null }));
    expect(result.stop_reason).toBe('other');
  });

  it('maps usage fields and leaves cache fields undefined when 0', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.usage.cache_read_tokens).toBeUndefined();
    expect(result.usage.cache_creation_tokens).toBeUndefined();
  });

  it('surfaces cache_read_tokens and cache_creation_tokens when non-zero', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
        },
      }),
    );
    expect(result.usage.cache_read_tokens).toBe(2000);
    expect(result.usage.cache_creation_tokens).toBe(500);
  });

  it('handles null cache token fields gracefully (treats as 0 → omitted)', () => {
    const result = anthropicResponseToCanonical(
      fakeMessage({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );
    expect(result.usage.cache_read_tokens).toBeUndefined();
    expect(result.usage.cache_creation_tokens).toBeUndefined();
  });

  it('leaves provider_state undefined (Anthropic does not need a replay blob)', () => {
    const result = anthropicResponseToCanonical(fakeMessage({}));
    expect(result.provider_state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider (class adapter)
// ---------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });
  afterEach(() => {
    createSpy.mockReset();
  });

  it('has id === "anthropic"', () => {
    expect(new AnthropicProvider('sk-test').id).toBe('anthropic');
  });

  describe('inputTokensFullRate (canonical-usage method)', () => {
    const provider = new AnthropicProvider('sk-test');

    // Anthropic's `input_tokens` already excludes cache_read and is the
    // non-cached portion. cache_creation rides separately on the Budget
    // accumulator's `cache_creation_input_tokens` field. So this method
    // returns input_tokens unchanged regardless of cache_creation or
    // cache_read; the per-model accumulator combines them downstream.
    it('returns input_tokens unchanged when cache_creation is set', () => {
      expect(
        provider.inputTokensFullRate({
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: 50,
        }),
      ).toBe(100);
    });

    it('returns input_tokens unchanged when cache_read is set (PR #13 budget semantics)', () => {
      expect(
        provider.inputTokensFullRate({
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 1000,
        }),
      ).toBe(100);
    });

    it('returns input_tokens unchanged when no cache fields are present', () => {
      expect(
        provider.inputTokensFullRate({
          input_tokens: 42,
          output_tokens: 1,
        }),
      ).toBe(42);
    });
  });

  describe('complete()', () => {
    it('calls the SDK with the expected body shape and returns a canonical response', async () => {
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: 'Reviewing.', citations: null },
          { type: 'tool_use', id: 't1', name: 'get_pr_diff', input: {} },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 200,
          output_tokens: 75,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 100,
        },
      });

      const provider = new AnthropicProvider('sk-test');
      const tools: CanonicalTool[] = [
        {
          name: 'get_pr_diff',
          description: 'fetch the PR diff',
          input_schema: { type: 'object', properties: {} },
        },
      ];

      const result = await provider.complete([{ role: 'user', content: 'review this' }], tools, {
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 4096,
        system: 'You are a reviewer.',
      });

      // 1. Spy was called once with the expected shape.
      expect(createSpy).toHaveBeenCalledTimes(1);
      const [body, requestOpts] = createSpy.mock.calls[0]!;
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0.5); // default from CompleteOptions
      expect(body.system).toEqual([
        { type: 'text', text: 'You are a reviewer.', cache_control: { type: 'ephemeral' } },
      ]);
      expect(body.messages).toEqual([{ role: 'user', content: 'review this' }]);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('get_pr_diff');
      expect(body.tools[0]).toHaveProperty('cache_control', { type: 'ephemeral' });
      // No abortSignal supplied → second arg should be undefined.
      expect(requestOpts).toBeUndefined();

      // 2. Returned shape is canonical.
      expect(result.text).toBe('Reviewing.');
      expect(result.tool_calls).toEqual([{ id: 't1', name: 'get_pr_diff', arguments: {} }]);
      expect(result.stop_reason).toBe('tool_calls');
      expect(result.usage).toEqual({
        input_tokens: 200,
        output_tokens: 75,
        cache_read_tokens: 1500,
        cache_creation_tokens: 100,
      });
      expect(result.provider_state).toBeUndefined();
    });

    it('honors the provided temperature override', async () => {
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      await new AnthropicProvider('sk-test').complete([], [], {
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
        system: 's',
        temperature: 0.2,
      });
      expect(createSpy.mock.calls[0]![0].temperature).toBe(0.2);
    });

    it('passes abortSignal through to the SDK request opts', async () => {
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      const controller = new AbortController();
      await new AnthropicProvider('sk-test').complete([], [], {
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
        system: 's',
        abortSignal: controller.signal,
      });
      expect(createSpy.mock.calls[0]![1]).toEqual({ signal: controller.signal });
    });

    it('applies sliding-window cache_control when sending tool_results back', async () => {
      // Two tool-results turns → both should be marked.
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      await new AnthropicProvider('sk-test').complete(
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            tool_calls: [{ id: 't1', name: 'x', arguments: {} }],
          },
          { role: 'tool', tool_call_id: 't1', content: 'result-1' },
          {
            role: 'assistant',
            tool_calls: [{ id: 't2', name: 'x', arguments: {} }],
          },
          { role: 'tool', tool_call_id: 't2', content: 'result-2' },
        ],
        [],
        { model: 'claude-sonnet-4-6', maxOutputTokens: 100, system: 's' },
      );
      const sentMessages = createSpy.mock.calls[0]![0].messages as Anthropic.MessageParam[];
      // Latest two array-content user messages (indices 2 and 4) should each
      // have cache_control on their last block.
      const trBlocks2 = (sentMessages[2] as unknown as { content: Block[] }).content;
      const trBlocks4 = (sentMessages[4] as unknown as { content: Block[] }).content;
      expect(hasCache(trBlocks2[trBlocks2.length - 1])).toBe(true);
      expect(hasCache(trBlocks4[trBlocks4.length - 1])).toBe(true);
    });

    it('caps max_tokens at SAFE_NON_STREAMING_MAX_TOKENS (8192) when caller requests more (CI regression after d116f2b)', async () => {
      // Anthropic SDK rejects non-streaming requests with max_tokens > 8192
      // ("Streaming is strongly recommended for operations that may take
      // longer than 10 minutes"). The runner's `input.maxOutputTokens` comes
      // from `budget.max_output_tokens` (default 50K) — a turn-cumulative
      // ceiling, not a per-request one. Cap here so a higher operator config
      // doesn't 400 every call.
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const provider = new AnthropicProvider('sk-test');
      await provider.complete([{ role: 'user', content: 'go' }], [], {
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 50_000,
        system: 's',
      });
      const body = createSpy.mock.calls[0]![0];
      expect(body.max_tokens).toBe(SAFE_NON_STREAMING_MAX_TOKENS);
      expect(body.max_tokens).toBe(8192);
    });

    it('forwards max_tokens unchanged when caller requests at or below the cap', async () => {
      createSpy.mockResolvedValueOnce({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const provider = new AnthropicProvider('sk-test');
      await provider.complete([{ role: 'user', content: 'go' }], [], {
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 4096,
        system: 's',
      });
      expect(createSpy.mock.calls[0]![0].max_tokens).toBe(4096);
    });
  });
});
