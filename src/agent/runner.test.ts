/**
 * Runner tests — provider-agnostic loop.
 *
 * Strategy: inject a `FakeProvider` (implements `LLMProvider`) by mocking
 * `createProvider`. This lets us script per-turn canonical responses and
 * inspect exactly what messages/tools/options the runner passes through —
 * without ever touching the Anthropic or OpenAI SDKs.
 *
 * A small set of `describe('Anthropic / OpenAI routing')` tests at the bottom
 * un-mocks `createProvider` to confirm `createProvider` still resolves the
 * right adapter for `claude-*` vs `gpt-*` model ids. Those tests don't make
 * network calls — they only inspect `provider.id`.
 *
 * Helper-level tests (`markLatestMessageForCaching`,
 * `AnthropicProvider#inputTokensFullRate`, etc.) live in
 * `src/llm/anthropic-provider.test.ts` — this file is purely about the loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalUsage,
  CompleteOptions,
  CompleteResponse,
  LLMProvider,
  ProviderId,
} from '../llm/index.js';

// Mock createProvider so tests can inject a scripted FakeProvider per case.
// `importActual` keeps the type re-exports + `inferProviderFromModel` real
// so the routing-integration tests below can still use them.
vi.mock('../llm/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../llm/index.js')>();
  return { ...actual, createProvider: vi.fn() };
});

// Import the SUT and the mocked helper AFTER vi.mock so we get the spy.
import { runAgent } from './runner.js';
import * as llmIndex from '../llm/index.js';
import { buildFakeDeps } from '../tools/test-helpers.js';

/**
 * Scriptable LLMProvider for runner tests. Construct with a list of
 * CompleteResponses, one per turn the runner will call. Inspect
 * `completeCalls` after the run to assert what the runner passed in.
 *
 * We deep-clone the messages on each call so mutations the runner makes
 * AFTER `complete()` returns (e.g. pushing the assistant turn + tool results)
 * don't retroactively change earlier captured snapshots.
 */
class FakeProvider implements LLMProvider {
  readonly id: ProviderId;
  public completeCalls: Array<{
    messages: CanonicalMessage[];
    tools: CanonicalTool[];
    opts: CompleteOptions;
  }> = [];

  constructor(
    private readonly script: CompleteResponse[],
    id: ProviderId = 'anthropic',
  ) {
    this.id = id;
  }

  async complete(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: CompleteOptions,
  ): Promise<CompleteResponse> {
    this.completeCalls.push({
      messages: structuredClone(messages),
      tools,
      opts,
    });
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error('FakeProvider script exhausted');
    }
    return next;
  }

  inputTokensFullRate(usage: CanonicalUsage): number {
    // Mirror the real adapters' per-id semantics so OpenAI tests in this
    // file exercise the cache_read subtraction. Anthropic: input_tokens
    // unchanged (already non-cached). OpenAI: subtract cache_read since
    // it's a subset of input_tokens.
    if (this.id === 'openai') {
      return usage.input_tokens - (usage.cache_read_tokens ?? 0);
    }
    return usage.input_tokens;
  }
}

function makeResponse(over: Partial<CompleteResponse> = {}): CompleteResponse {
  return {
    text: '',
    tool_calls: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
    ...over,
  };
}

const baseInput = () => ({
  deps: buildFakeDeps(),
  systemPrompt: 'You are a code reviewer.',
  userPrompt: 'Review this PR.',
  model: 'claude-sonnet-4-6',
  maxTurns: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 100_000,
  apiKey: 'sk-test',
});

describe('runAgent', () => {
  beforeEach(() => {
    vi.mocked(llmIndex.createProvider).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a single turn that ends with end_turn and no tool calls', async () => {
    const provider = new FakeProvider([
      makeResponse({
        text: 'looks good',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent(baseInput());

    expect(provider.completeCalls).toHaveLength(1);
    // No summary was posted by the model, so we exit via the post-response
    // branch flagged as `max_turns` (the agent stopped without finishing).
    expect(result.ended).toBe('max_turns');
    expect(result.turns).toBe(1);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('passes opts (model, maxOutputTokens, system, temperature, abortSignal) to provider.complete', async () => {
    const provider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const abortController = new AbortController();
    await runAgent({ ...baseInput(), abortController });

    expect(provider.completeCalls[0]!.opts).toMatchObject({
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 8192,
      system: 'You are a code reviewer.',
      temperature: 0.5,
    });
    // abortSignal must be the controller's signal — not just truthy. Identity
    // matters because the adapters forward it to the SDK's underlying fetch.
    expect(provider.completeCalls[0]!.opts.abortSignal).toBe(abortController.signal);
  });

  it('omits abortSignal when no abortController is supplied', async () => {
    const provider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    expect(provider.completeCalls[0]!.opts.abortSignal).toBeUndefined();
  });

  it('passes the caller-supplied temperature through to the provider (and defaults to 0.5 when omitted)', async () => {
    // Default path: input.temperature undefined → DEFAULT_TEMPERATURE (0.5).
    const defaultProvider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValueOnce(defaultProvider);
    await runAgent(baseInput());
    expect(defaultProvider.completeCalls[0]!.opts.temperature).toBe(0.5);

    // Override path: input.temperature = 0.2 → forwarded verbatim. Pins the
    // contract so future config plumbing (Task 5) lands on a tested seam.
    const overrideProvider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValueOnce(overrideProvider);
    await runAgent({ ...baseInput(), temperature: 0.2 });
    expect(overrideProvider.completeCalls[0]!.opts.temperature).toBe(0.2);
  });

  it('passes canonical tools (without handler) to provider.complete', async () => {
    const provider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    const tools = provider.completeCalls[0]!.tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('input_schema');
      // Critical: handler must be stripped — providers don't need it and we
      // don't want vendor adapters to accidentally serialize/log it.
      expect(t).not.toHaveProperty('handler');
      expect(t.input_schema.type).toBe('object');
    }
    // Sanity: post_summary should be in the tools list (we use it in the
    // next test).
    expect(tools.some((t) => t.name === 'post_summary')).toBe(true);
  });

  it('executes a tool_call, pushes a canonical tool message, and continues to the next turn', async () => {
    const input = baseInput();
    const provider = new FakeProvider([
      // Turn 1: model calls post_summary.
      makeResponse({
        text: 'wrapping up',
        tool_calls: [
          {
            id: 'call_1',
            name: 'post_summary',
            arguments: {
              strengths: ['Thorough test coverage on the new helper'],
              assessment: 'approve',
              assessment_reasoning: 'No issues found; tests look solid and behavior is sound.',
            },
          },
        ],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent(input);

    // Loop terminates after summary post; only one provider call.
    expect(provider.completeCalls).toHaveLength(1);
    expect(result.ended).toBe('summary_posted');
    expect(result.turns).toBe(1);
    // Aggregator state confirms the tool actually ran.
    expect(input.deps.aggregator.hasSummary()).toBe(true);
  });

  it('round-trips assistant turn + tool message into the next turn`s messages array', async () => {
    const input = baseInput();
    const provider = new FakeProvider([
      // Turn 1: model wants a tool.
      makeResponse({
        text: 'let me look',
        tool_calls: [
          { id: 'call_1', name: 'get_pr_metadata', arguments: {} },
        ],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      // Turn 2: model wraps up by calling post_summary.
      makeResponse({
        tool_calls: [
          {
            id: 'call_2',
            name: 'post_summary',
            arguments: {
              strengths: ['Test coverage looks decent on this slice'],
              assessment: 'approve',
              assessment_reasoning: 'Reviewed the diff and metadata; nothing concerning.',
            },
          },
        ],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 150, output_tokens: 60 },
      }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent(input);

    expect(provider.completeCalls).toHaveLength(2);
    expect(result.ended).toBe('summary_posted');
    expect(result.turns).toBe(2);

    // Turn 2's messages must contain: [user, assistant(turn1), tool(call_1 result)].
    const turn2Messages = provider.completeCalls[1]!.messages;
    expect(turn2Messages).toHaveLength(3);
    expect(turn2Messages[0]!.role).toBe('user');

    const asst = turn2Messages[1]!;
    expect(asst.role).toBe('assistant');
    if (asst.role !== 'assistant') throw new Error('unreachable'); // narrow
    expect(asst.text).toBe('let me look');
    expect(asst.tool_calls).toEqual([
      { id: 'call_1', name: 'get_pr_metadata', arguments: {} },
    ]);

    const toolMsg = turn2Messages[2]!;
    expect(toolMsg.role).toBe('tool');
    if (toolMsg.role !== 'tool') throw new Error('unreachable'); // narrow
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBeTruthy(); // get_pr_metadata returns JSON
    expect(toolMsg.is_error).toBeUndefined();
  });

  it('accumulates tokens and computes cost across multiple turns', async () => {
    const provider = new FakeProvider([
      makeResponse({
        tool_calls: [{ id: 'c1', name: 'get_pr_metadata', arguments: {} }],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      makeResponse({
        text: 'done',
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent(baseInput());

    expect(result.turns).toBe(2);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(130);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('exits early with `budget_exceeded` when the input-token cap is hit', async () => {
    const provider = new FakeProvider([
      makeResponse({
        usage: { input_tokens: 1_000_000, output_tokens: 50 },
      }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent({ ...baseInput(), maxInputTokens: 500_000 });

    expect(result.ended).toBe('budget_exceeded');
    expect(result.error).toBeTruthy();
    expect(result.turns).toBe(1);
  });

  it('treats OpenAI input_tokens minus cache_read as the billable portion (Codex P1 #3300602652)', async () => {
    // OpenAI reports input_tokens INCLUDING cached_tokens (cached is a subset
    // of input). Without subtracting cache_read at the Budget boundary, a
    // cache-heavy OpenAI run would trip max_input_tokens early — the bug
    // Codex flagged on commit 766d3aac.
    //
    // Construct a single turn where the raw input is over the cap but the
    // billable portion (input - cache_read) is well under it. The run must
    // complete successfully.
    const provider = new FakeProvider(
      [
        makeResponse({
          text: 'fine',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 800_000, // raw input includes cached tokens
            output_tokens: 50,
            cache_read_tokens: 600_000, // 600K cached → billable = 200K
          },
        }),
      ],
      'openai',
    );
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent({
      ...baseInput(),
      model: 'gpt-4.1',
      maxInputTokens: 500_000, // billable 200K < cap, raw 800K > cap
    });

    expect(result.ended).not.toBe('budget_exceeded');
    expect(result.ended).toBe('max_turns');
    // perModelCost reports input_tokens as the full-rate portion only
    // (consistent semantics across providers); cache_read shows the
    // discounted portion separately.
    expect(result.perModelCost).toHaveLength(1);
    expect(result.perModelCost[0]!.inputTokens).toBe(200_000);
    expect(result.perModelCost[0]!.cacheReadTokens).toBe(600_000);
    // gpt-4.1: input $2/M + cache_read $0.5/M
    //   = 200_000 * 2/1M + 600_000 * 0.5/1M + 50 * 8/1M
    //   = $0.4 + $0.3 + $0.0004 = $0.7004
    // Critical: this should NOT include 800_000 * $2/M = $1.60 of double-counted input.
    expect(result.costUsd).toBeCloseTo(0.7004, 4);
  });

  it('keeps Anthropic billable formula unchanged (input + cache_creation, cache_read excluded)', async () => {
    // Regression guard for the same fix as above — make sure adding the
    // OpenAI branch didn't perturb the Anthropic path. Anthropic reports
    // input_tokens EXCLUDING cache_read, so the runner must NOT subtract
    // it again.
    const provider = new FakeProvider(
      [
        makeResponse({
          text: 'fine',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 200_000, // already excludes cache_read
            output_tokens: 50,
            cache_creation_tokens: 100_000,
            cache_read_tokens: 600_000,
          },
        }),
      ],
      'anthropic',
    );
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const result = await runAgent({ ...baseInput(), maxInputTokens: 500_000 });

    // billable = 200K + 100K cache_creation = 300K < 500K cap → completes.
    expect(result.ended).not.toBe('budget_exceeded');
    expect(result.perModelCost[0]!.inputTokens).toBe(200_000);
    expect(result.perModelCost[0]!.cacheCreationTokens).toBe(100_000);
    expect(result.perModelCost[0]!.cacheReadTokens).toBe(600_000);
  });

  it('exits with `aborted` when the abortController is fired before the first turn', async () => {
    const provider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    const abortController = new AbortController();
    abortController.abort();

    const result = await runAgent({ ...baseInput(), abortController });

    expect(result.ended).toBe('aborted');
    // Provider must NOT have been called — abort check happens at the top
    // of the loop before complete().
    expect(provider.completeCalls).toHaveLength(0);
  });

  it('emits an is_error tool message when the model calls a tool that does not exist', async () => {
    const provider = new FakeProvider([
      makeResponse({
        tool_calls: [{ id: 'call_x', name: 'nonexistent_tool', arguments: {} }],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      // Turn 2 returns end_turn so we can read what messages got pushed.
      makeResponse({ text: 'sorry', stop_reason: 'end_turn' }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    expect(provider.completeCalls).toHaveLength(2);
    const turn2Messages = provider.completeCalls[1]!.messages;
    const lastMsg = turn2Messages[turn2Messages.length - 1]!;
    expect(lastMsg.role).toBe('tool');
    if (lastMsg.role !== 'tool') throw new Error('unreachable');
    expect(lastMsg.tool_call_id).toBe('call_x');
    expect(lastMsg.is_error).toBe(true);
    expect(lastMsg.content).toBe('Unknown tool: nonexistent_tool');
  });

  it('emits an is_error tool message when a tool handler throws', async () => {
    const input = baseInput();
    // Inject a fileReader.read that throws so get_pr_metadata can succeed
    // but read_file_at_ref will throw. (We script the model to call
    // read_file_at_ref.)
    const throwingDeps = buildFakeDeps({
      fileReader: {
        read: async () => {
          throw new Error('disk full');
        },
        readRange: async () => {
          throw new Error('disk full');
        },
      },
    });

    const provider = new FakeProvider([
      makeResponse({
        tool_calls: [
          {
            id: 'call_r',
            name: 'read_file_at_ref',
            arguments: { path: 'src/foo.ts', ref: 'head' },
          },
        ],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      makeResponse({ text: 'ok', stop_reason: 'end_turn' }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent({ ...input, deps: throwingDeps });

    // The runner should have pushed an is_error tool message that the next
    // turn carries forward. We don't assert the exact wording of the error —
    // some tools wrap exceptions before they hit our `catch` — but the
    // runner's contract is: handler throw → is_error tool message back.
    expect(provider.completeCalls).toHaveLength(2);
    const turn2Messages = provider.completeCalls[1]!.messages;
    const lastMsg = turn2Messages[turn2Messages.length - 1]!;
    expect(lastMsg.role).toBe('tool');
    if (lastMsg.role !== 'tool') throw new Error('unreachable');
    expect(lastMsg.tool_call_id).toBe('call_r');
  });

  it('round-trips provider_state on the assistant message into the next turn', async () => {
    // Stand-in payload — runner is opaque to whatever the provider stashes here.
    const fakeProviderState = [
      { type: 'reasoning', encrypted_content: 'abc' },
      { type: 'message', role: 'assistant', content: [] },
    ];
    const provider = new FakeProvider([
      makeResponse({
        text: 'thinking',
        tool_calls: [{ id: 'c1', name: 'get_pr_metadata', arguments: {} }],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
        provider_state: fakeProviderState,
      }),
      makeResponse({ text: 'done', stop_reason: 'end_turn' }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    expect(provider.completeCalls).toHaveLength(2);
    const turn2Messages = provider.completeCalls[1]!.messages;
    // [user, assistant(turn1 with provider_state), tool(call_1)]
    const asst = turn2Messages[1]!;
    expect(asst.role).toBe('assistant');
    if (asst.role !== 'assistant') throw new Error('unreachable');
    expect(asst.provider_state).toEqual(fakeProviderState);
  });

  it('does NOT set provider_state on the assistant message when the response omits it', async () => {
    const provider = new FakeProvider([
      makeResponse({
        text: 'no state',
        tool_calls: [{ id: 'c1', name: 'get_pr_metadata', arguments: {} }],
        stop_reason: 'tool_calls',
        usage: { input_tokens: 100, output_tokens: 50 },
        // Explicitly leave provider_state undefined.
      }),
      makeResponse({ text: 'fin', stop_reason: 'end_turn' }),
    ]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    const turn2Messages = provider.completeCalls[1]!.messages;
    const asst = turn2Messages[1]!;
    expect(asst.role).toBe('assistant');
    if (asst.role !== 'assistant') throw new Error('unreachable');
    expect(asst.provider_state).toBeUndefined();
  });

  it('forwards providerHint to createProvider when supplied', async () => {
    const provider = new FakeProvider([makeResponse()], 'openai');
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent({ ...baseInput(), providerHint: 'openai' });

    expect(llmIndex.createProvider).toHaveBeenCalledWith({
      modelId: 'claude-sonnet-4-6',
      apiKey: 'sk-test',
      providerHint: 'openai',
    });
  });

  it('omits providerHint from the createProvider input when not supplied', async () => {
    const provider = new FakeProvider([makeResponse()]);
    vi.mocked(llmIndex.createProvider).mockReturnValue(provider);

    await runAgent(baseInput());

    expect(llmIndex.createProvider).toHaveBeenCalledWith({
      modelId: 'claude-sonnet-4-6',
      apiKey: 'sk-test',
    });
  });
});

// ---------------------------------------------------------------------------
// Provider-routing smoke — un-mock createProvider and call it directly to pin
// that each model-id family round-trips through the REAL factory and produces
// the right adapter instance. Not a runner integration — the runner is
// already covered above through FakeProvider; this block deliberately bypasses
// it because the routing decision happens in `createProvider`, not in
// `runAgent`. No network calls (we only inspect `provider.id`, never
// `.complete()`).
// ---------------------------------------------------------------------------

describe('createProvider (real factory) — model-id routing', () => {
  // These tests pin the router contract so a regression in
  // `inferProviderFromModel` surfaces as a runner-package test failure
  // (the runner is the only production caller of `createProvider`).

  it('routes claude-* model ids to the Anthropic adapter', async () => {
    const actual = await vi.importActual<typeof import('../llm/index.js')>('../llm/index.js');
    const provider = actual.createProvider({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-test' });
    expect(provider.id).toBe('anthropic');
  });

  it('routes gpt-* model ids to the OpenAI adapter', async () => {
    const actual = await vi.importActual<typeof import('../llm/index.js')>('../llm/index.js');
    const provider = actual.createProvider({ modelId: 'gpt-4.1', apiKey: 'sk-test' });
    expect(provider.id).toBe('openai');
  });

  it('routes o-series model ids to the OpenAI adapter', async () => {
    const actual = await vi.importActual<typeof import('../llm/index.js')>('../llm/index.js');
    const provider = actual.createProvider({ modelId: 'o4-mini', apiKey: 'sk-test' });
    expect(provider.id).toBe('openai');
  });
});
