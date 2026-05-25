import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  billableInputTokensForBudget,
  markLatestMessageForCaching,
} from './runner.js';

type Block = Record<string, unknown>;

function hasCache(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === 'object' &&
    'cache_control' in (block as Block)
  );
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
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'initial user prompt' },
    ];
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

describe('billableInputTokensForBudget', () => {
  it('counts non-cached input_tokens', () => {
    expect(billableInputTokensForBudget({ input_tokens: 100 })).toBe(100);
  });

  it('counts cache_creation_input_tokens (billed at 1.25× — full-cost equivalent)', () => {
    expect(
      billableInputTokensForBudget({ input_tokens: 100, cache_creation_input_tokens: 50 }),
    ).toBe(150);
  });

  it('does NOT count cache_read_input_tokens (billed at 0.1× — would over-trip the budget cap)', () => {
    // Pinning the asymmetry. A future "fix" that includes cache_read would
    // make the default 500K cap fire on turn 1 of any cached run (real eval
    // data showed cache_read ≈ 800K-1.5M per case). The helper's input type
    // doesn't declare cache_read_input_tokens at all, so the only way to
    // regress is to actually change the formula — at which point this test
    // and the JSDoc both need explicit updates.
    expect(
      billableInputTokensForBudget({ input_tokens: 100, cache_creation_input_tokens: 0 }),
    ).toBe(100);
  });

  it('treats missing/null cache_creation_input_tokens as 0', () => {
    expect(billableInputTokensForBudget({ input_tokens: 42 })).toBe(42);
    expect(
      billableInputTokensForBudget({ input_tokens: 42, cache_creation_input_tokens: null }),
    ).toBe(42);
    expect(
      billableInputTokensForBudget({
        input_tokens: 42,
        cache_creation_input_tokens: undefined,
      }),
    ).toBe(42);
  });
});

