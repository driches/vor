/**
 * Anthropic adapter implementing the canonical `LLMProvider` surface.
 *
 * The runner currently still drives the Anthropic SDK directly (see
 * `src/agent/runner.ts`) — Task 4 will refactor that loop to call
 * `provider.complete()`. Until then, this module owns:
 *  1. The class adapter (`AnthropicProvider`) that future provider-agnostic
 *     callers will use.
 *  2. The cache-breakpoint helpers (`markLatestMessageForCaching`,
 *     `markLastBlockForCaching`) the runner imports today — moved here so the
 *     Anthropic-specific behavior lives in one place.
 *  3. A standalone `billableInputTokensForBudget(usage)` that takes the raw
 *     Anthropic-SDK usage shape, so the runner can keep its current budget
 *     gate without instantiating the class (the class method takes
 *     `CanonicalUsage` instead — both exist intentionally).
 *
 * The conversion helpers (`canonicalMessagesToAnthropic`, etc.) are
 * module-private but exported under `__internal` for unit testing.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalUsage,
  CompleteOptions,
  CompleteResponse,
  LLMProvider,
  StopReason,
} from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: CompleteOptions,
  ): Promise<CompleteResponse> {
    const anthropicMessages = canonicalMessagesToAnthropic(messages);
    // Sliding-window cache_control on the two most recent array-content user
    // messages (see markLatestMessageForCaching JSDoc for the 4-breakpoint
    // budget math).
    markLatestMessageForCaching(anthropicMessages);
    const anthropicTools = canonicalToolsToAnthropic(tools);

    const response = await this.client.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxOutputTokens,
        temperature: opts.temperature ?? 0.5,
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        messages: anthropicMessages,
        tools: anthropicTools,
      },
      opts.abortSignal ? { signal: opts.abortSignal } : undefined,
    );

    return anthropicResponseToCanonical(response);
  }

  /**
   * Canonical-shape input budget formula. Mirrors the standalone
   * `billableInputTokensForBudget(usage)` below but takes the canonical
   * `CanonicalUsage` field names (`cache_creation_tokens` vs Anthropic's raw
   * `cache_creation_input_tokens`). See that function's JSDoc for the
   * rationale on excluding cache reads.
   */
  billableInputTokensForBudget(usage: CanonicalUsage): number {
    return usage.input_tokens + (usage.cache_creation_tokens ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Translate canonical messages into Anthropic `MessageParam[]`.
 *
 *  - `user` (string content) round-trips unchanged.
 *  - `assistant` becomes a content array of `text` and/or `tool_use` blocks.
 *    `provider_state` is dropped — it's OpenAI's replay payload and Anthropic
 *    has no place to put it.
 *  - `tool` messages become `tool_result` blocks wrapped in a user message.
 *    CONSECUTIVE `tool` messages collapse into a SINGLE user message with
 *    multiple `tool_result` blocks, because Anthropic expects all tool
 *    results from one assistant turn in one user message — splitting them
 *    would either fail validation or get rejected as out-of-order role
 *    alternation.
 */
export function canonicalMessagesToAnthropic(
  messages: CanonicalMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.text !== undefined && msg.text.length > 0) {
        blocks.push({ type: 'text', text: msg.text });
      }
      if (msg.tool_calls !== undefined) {
        for (const call of msg.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          });
        }
      }
      out.push({ role: 'assistant', content: blocks });
      i++;
      continue;
    }

    // role === 'tool' — consume this and any adjacent tool messages into a
    // single user-message wrapper.
    const toolBlocks: Anthropic.ToolResultBlockParam[] = [];
    while (i < messages.length && messages[i]!.role === 'tool') {
      const t = messages[i] as Extract<CanonicalMessage, { role: 'tool' }>;
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: t.tool_call_id,
        content: t.content,
      };
      if (t.is_error === true) block.is_error = true;
      toolBlocks.push(block);
      i++;
    }
    out.push({ role: 'user', content: toolBlocks });
  }

  return out;
}

/**
 * Translate canonical tools into Anthropic `Tool[]`. The shape is already
 * compatible; the only material change is marking the LAST tool with
 * `cache_control: { type: 'ephemeral' }` so the ~2-3K token tool-schema
 * block reads from cache on every turn instead of re-billing at full input
 * rate (one of the 4 cache_control breakpoints budgeted per request — see
 * the breakpoint accounting in `markLatestMessageForCaching`).
 */
export function canonicalToolsToAnthropic(tools: CanonicalTool[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

/**
 * Translate an Anthropic `Message` response back into a canonical
 * `CompleteResponse`. Collapses the provider's stop_reason taxonomy onto our
 * smaller `StopReason` union (anything besides end_turn/tool_use/max_tokens
 * becomes `'other'`), and renames cache token fields onto our canonical
 * names. `provider_state` is left undefined — Anthropic doesn't need a
 * replay blob (it's stateless wrt reasoning).
 */
export function anthropicResponseToCanonical(response: Anthropic.Message): CompleteResponse {
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  const toolUseBlocks = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  const text = textBlocks.map((t) => t.text).join('');
  const tool_calls: CanonicalToolCall[] = toolUseBlocks.map((u) => ({
    id: u.id,
    name: u.name,
    arguments: (u.input ?? {}) as Record<string, unknown>,
  }));

  let stop_reason: StopReason;
  switch (response.stop_reason) {
    case 'end_turn':
      stop_reason = 'end_turn';
      break;
    case 'tool_use':
      stop_reason = 'tool_calls';
      break;
    case 'max_tokens':
      stop_reason = 'max_tokens';
      break;
    default:
      stop_reason = 'other';
  }

  const usage: CanonicalUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
  // Leave cache_* fields undefined when 0 — matches OpenAI parity (their
  // adapter should also omit cache_read_tokens when nothing was cached) and
  // keeps downstream telemetry from logging noisy `cache_r=0` lines on first
  // turns. The pricing math already guards with `?? 0` so this can't NaN.
  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  if (cacheRead > 0) usage.cache_read_tokens = cacheRead;
  const cacheCreation = response.usage.cache_creation_input_tokens ?? 0;
  if (cacheCreation > 0) usage.cache_creation_tokens = cacheCreation;

  return {
    text,
    tool_calls,
    stop_reason,
    usage,
    provider_state: undefined,
  };
}

// ---------------------------------------------------------------------------
// Cache-control helpers (still imported by src/agent/runner.ts today; will
// only be called from inside this module once Task 4 lands)
// ---------------------------------------------------------------------------

/**
 * Maintain ephemeral cache_control breakpoints on the two most recent
 * array-content user messages and strip any older ones. Two breakpoints
 * (instead of one) keep a fallback cache anchor available for the prefix
 * from the previous turn: Anthropic's cache lookup backtracks a bounded
 * number of blocks from each breakpoint, so a high-fanout turn (e.g. many
 * parallel tool calls) could otherwise push the previous cache boundary out
 * of range when we move the single breakpoint to the new latest message.
 *
 * Two message breakpoints + the system breakpoint + the last-tool breakpoint
 * = 4 total, exactly at the API's per-request limit.
 *
 * Breakpoint count per turn (turn 1 is the initial user prompt before any
 * tool calls — that message has string content, not array, so it does not
 * count toward `userIndices`):
 *   - Turn 1: 0 message breakpoints (no array-content user messages yet).
 *   - Turn 2: 1 message breakpoint (the first tool_results push).
 *   - Turn 3+: 2 message breakpoints (latest + previous tool_results).
 *
 * We RE-mark the second-latest breakpoint explicitly each call rather than
 * relying on the carry-forward of a previous turn's marking, so the function
 * is obviously correct from a single-turn read without needing to trace
 * cross-turn state. Exported so the unit tests can exercise edge cases.
 *
 * Why we cache at all: each turn re-sends the entire prior conversation
 * (assistant turns + tool_results, which can include 100KB diffs and 500-line
 * file reads). Without breakpoints, every turn re-bills that growing prefix
 * at the full input rate. With them, the prefix reads from cache at the
 * cache_read rate and only the new turn's content is billed at full rate.
 */
export function markLatestMessageForCaching(messages: Anthropic.MessageParam[]): void {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content)) userIndices.push(i);
  }
  if (userIndices.length === 0) return;

  const keep = new Set(userIndices.slice(-2));
  for (const i of userIndices) {
    if (keep.has(i)) continue;
    const content = messages[i]!.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block !== null && typeof block === 'object' && 'cache_control' in block) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }

  if (userIndices.length >= 2) {
    markLastBlockForCaching(messages[userIndices[userIndices.length - 2]!]!);
  }
  markLastBlockForCaching(messages[userIndices[userIndices.length - 1]!]!);
}

export function markLastBlockForCaching(message: Anthropic.MessageParam): void {
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const lastBlock = message.content[message.content.length - 1];
  if (lastBlock === undefined || typeof lastBlock !== 'object' || lastBlock === null) return;
  (lastBlock as { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' };
}

// ---------------------------------------------------------------------------
// Standalone budget helper for the runner (kept until Task 4 refactors the
// loop to call provider.billableInputTokensForBudget on a CanonicalUsage).
// ---------------------------------------------------------------------------

/**
 * Compute the input-token count that should count against the runner's
 * `max_input_tokens` budget gate, given an Anthropic API response usage block.
 *
 * Includes:
 *   - `input_tokens` (non-cached input — billed at full rate, 1×)
 *   - `cache_creation_input_tokens` (billed at 1.25× input rate — full-cost
 *     equivalent, so it should count against any "input budget" gate)
 *
 * Deliberately EXCLUDES `cache_read_input_tokens`. Cache reads are billed at
 * 0.1× input rate (effectively free) and typically dominate the raw token
 * count on cached runs (real eval data: cache_read ≈ 800K-1.5M per case vs
 * input ≈ 400 per turn). Counting them would make the default 500K
 * `max_input_tokens` cap fire on the first turn of any cache-heavy run,
 * regressing every operator config sized against the pre-caching semantic.
 *
 * Exported so the unit tests can pin this contract — if the formula ever
 * changes (e.g. someone "fixes" it to count all three), the test should fail
 * visibly rather than silently shifting the budget threshold.
 */
export function billableInputTokensForBudget(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
}): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
}
