/**
 * OpenAI adapter implementing the canonical `LLMProvider` surface.
 *
 * Targets the Responses API (`POST /v1/responses`), NOT Chat Completions —
 * Chat Completions is on OpenAI's deprecation path and the Responses surface
 * is the one we want to grow into (reasoning items, encrypted CoT, image
 * inputs, automatic prompt caching). The runner refactor (Task 4) wires the
 * loop through this; until then this module owns:
 *   1. The class adapter (`OpenAIProvider`).
 *   2. Conversion helpers (canonicalMessagesToResponsesInput,
 *      canonicalToolsToResponses, responsesResponseToCanonical) — named
 *      exports so the unit tests can pin behavior directly.
 *   3. Model-shape predicates (`isReasoningModel`, `supportsTemperature`)
 *      that route around the o-series's "reject temperature" quirk.
 *
 * Stateless replay design: we set `store: false` on every request — we do
 * NOT use OpenAI's server-side `previous_response_id` continuation. The full
 * conversation is re-sent each turn (parity with the Anthropic adapter and
 * with how `src/agent/runner.ts` already operates). To preserve reasoning
 * across stateless turns for o-series models, the prior turn's full
 * `response.output[]` array is stashed verbatim into the canonical
 * `assistant.provider_state` and splatted back into the next request's
 * `input[]`. This carries the encrypted reasoning items (requested via
 * `include: ['reasoning.encrypted_content']`) so the model can pick up its
 * own chain-of-thought after a tool call.
 */

import OpenAI from 'openai';
import { logger } from '../util/logger.js';
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

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: CompleteOptions,
  ): Promise<CompleteResponse> {
    const input = canonicalMessagesToResponsesInput(messages);
    const responsesTools = canonicalToolsToResponses(tools);

    const reasoning = isReasoningModel(opts.model);
    const requestBody: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: opts.model,
      input,
      instructions: opts.system,
      tools: responsesTools,
      max_output_tokens: opts.maxOutputTokens,
      // Stateless: never let OpenAI persist the turn. We round-trip the
      // entire conversation ourselves (see provider_state replay in the
      // module JSDoc).
      store: false,
      // For o-series, ask for the encrypted reasoning items so we can replay
      // them next turn without retention. No-op on non-reasoning models, but
      // gpt-* will 400 if you pass an unsupported `include` value, hence the
      // conditional.
      ...(reasoning ? { include: ['reasoning.encrypted_content' as const] } : {}),
      // Reasoning models (o1/o3/o4) reject the `temperature` parameter —
      // they sample deterministically by design. Only send it for gpt-*.
      ...(supportsTemperature(opts.model) ? { temperature: opts.temperature ?? 0.5 } : {}),
    };

    const response = await this.client.responses.create(requestBody, {
      signal: opts.abortSignal,
    });

    return responsesResponseToCanonical(response);
  }

  /**
   * Mirrors PR #13's intent for the runner's `max_input_tokens` budget gate:
   * count only full-rate input, not the cached prefix. OpenAI reports
   * `cached_tokens` as a SUBSET of `input_tokens` (unlike Anthropic, where
   * cache reads are reported separately), so we subtract rather than add.
   * Without this, on a cache-heavy first turn the gate would fire against
   * the cached prefix alone.
   */
  billableInputTokensForBudget(usage: CanonicalUsage): number {
    return usage.input_tokens - (usage.cache_read_tokens ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Model-shape predicates
// ---------------------------------------------------------------------------

/**
 * o-series reasoning models: o1, o3, o3-mini, o4-mini, etc. Matches an `o`
 * followed by a digit so we don't false-positive `omni-*` or any future
 * non-reasoning model that happens to start with `o`.
 */
export function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model);
}

/**
 * Reasoning models (`o1`, `o3*`, `o4*`) 400 if you send `temperature`. Every
 * other OpenAI chat-capable model accepts it. Negation of `isReasoningModel`
 * to keep the two rules in sync — if a future model joins the o-series, the
 * single regex update covers both.
 */
export function supportsTemperature(model: string): boolean {
  return !isReasoningModel(model);
}

// ---------------------------------------------------------------------------
// Conversion helpers — canonical ↔ Responses API
// ---------------------------------------------------------------------------

/**
 * Recognize a provider_state payload that came from OpenAIProvider — i.e. an
 * array where every item has a string `type` field naming one of the
 * Responses API output item types. Defends against splatting payloads
 * stashed by a different provider (or by a test) into the Responses API
 * input, which would 400 or silently corrupt the turn.
 *
 * Empty array is treated as valid: an empty `output` means the prior turn
 * legitimately produced no content (rare but possible).
 *
 * The type list covers the documented Responses output item types. `message`,
 * `function_call`, and `reasoning` are the ones we actually see today; the
 * rest are forward-compat for OpenAI's tool ecosystem so adding a new
 * server-side tool doesn't immediately reject the splat path.
 */
function isOpenAIResponseOutput(arr: unknown[]): boolean {
  return arr.every((item): boolean => {
    if (item === null || typeof item !== 'object') return false;
    const t = (item as { type?: unknown }).type;
    if (typeof t !== 'string') return false;
    return (
      t === 'message' ||
      t === 'function_call' ||
      t === 'reasoning' ||
      t === 'function_call_output' ||
      t === 'refusal' ||
      t === 'web_search_call' ||
      t === 'file_search_call' ||
      t === 'computer_call' ||
      t === 'image_generation_call' ||
      t === 'code_interpreter_call' ||
      t === 'local_shell_call' ||
      t === 'mcp_call' ||
      t === 'mcp_list_tools' ||
      t === 'mcp_approval_request'
    );
  });
}

/**
 * Translate canonical messages into the Responses API `input[]` array.
 *
 *  - `user` (string content) → a `message` input item with one `input_text`
 *    content block.
 *  - `assistant` WITH `provider_state` → splat the previous turn's
 *    `response.output[]` verbatim. This carries text + function_calls +
 *    reasoning items together (the reasoning replay is the whole reason
 *    provider_state exists; for o-series, dropping it degrades the model's
 *    follow-up behavior). The canonical `text` and `tool_calls` on this
 *    same message are IGNORED in this branch — provider_state is the
 *    authoritative replay of what the model produced.
 *  - `assistant` WITHOUT `provider_state` (seed/synthesized messages —
 *    nothing came from a real prior API call) → emit an `output_text`
 *    message for any text plus one `function_call` item per tool_call.
 *  - `tool` (function result) → a `function_call_output` input item. Unlike
 *    Anthropic, the Responses API takes adjacent tool outputs as SEPARATE
 *    input items, not grouped under a single user message — so we emit one
 *    item per tool message and never collapse them.
 *
 * Defensive note on provider_state: if some future code path stashes a
 * non-array, or an array shaped for a different provider (e.g. Anthropic
 * content blocks), we fall back to the no-provider-state branch rather than
 * splatting items the Responses API can't parse. The validation runs through
 * `isOpenAIResponseOutput` — see that helper for the exact predicate.
 */
export function canonicalMessagesToResponsesInput(
  messages: CanonicalMessage[],
): OpenAI.Responses.ResponseInputItem[] {
  const out: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: msg.content }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      // Replay path: previous turn's response.output[] verbatim.
      // The shape check defends against a future Anthropic adapter (or a test)
      // stashing a non-OpenAI payload into provider_state — without it we'd
      // forward those items as Responses API input and 400 (or worse, corrupt
      // the turn silently).
      if (
        Array.isArray(msg.provider_state) &&
        isOpenAIResponseOutput(msg.provider_state)
      ) {
        for (const item of msg.provider_state as OpenAI.Responses.ResponseInputItem[]) {
          out.push(item);
        }
        continue;
      }

      // Synthesized/seed assistant message — derive items from text + tool_calls.
      // EasyInputMessage.content accepts a plain string for assistant role;
      // output_text is reserved for actual API RESPONSES, not request input.
      if (msg.text !== undefined && msg.text.length > 0) {
        out.push({
          type: 'message',
          role: 'assistant',
          content: msg.text,
        });
      }
      if (msg.tool_calls !== undefined) {
        for (const call of msg.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
      }
      continue;
    }

    // role === 'tool'
    out.push({
      type: 'function_call_output',
      call_id: msg.tool_call_id,
      output: msg.content,
    });
  }

  return out;
}

/**
 * Translate canonical tools into Responses API `FunctionTool[]`. Note the
 * shape is FLAT (`{type:'function', name, ...}`) — unlike Chat Completions
 * which nests under `{type:'function', function:{name, ...}}`. Easy to
 * confuse if you've worked with the legacy API.
 *
 * `strict: false` is deliberate: our Zod-derived `input_schema` allows
 * `additionalProperties: true` and has looser `required` lists than
 * OpenAI's strict-mode validator demands. Flipping to strict would reject
 * every tool call. The Responses API is responsible for auto-caching the
 * tool schema — there's no operator surface for cache_control here (and no
 * Anthropic-style 4-breakpoint budget to manage).
 */
export function canonicalToolsToResponses(
  tools: CanonicalTool[],
): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
    strict: false,
  }));
}

/**
 * Translate an OpenAI `Response` back into a canonical `CompleteResponse`.
 *
 * Output handling:
 *  - `message` items → walk `content[]`. `output_text` accumulates into
 *    canonical `text`. `refusal` PREEMPTS: prepends `[refused] ` and forces
 *    the text to the refusal explanation, then forces stop_reason to
 *    `end_turn` (the model has decided not to continue; surfacing it as a
 *    refused turn is more useful to the runner than mapping it to `other`).
 *  - `function_call` items → push to canonical `tool_calls`, JSON-parsing
 *    the `arguments` string. If the parse throws (model produced malformed
 *    JSON, which happens), emit a `logger.warn` for visibility AND surface
 *    an empty-args call so the runner can attempt recovery (the parameter-
 *    less call may still succeed for tools with optional args; otherwise
 *    the tool's own validation will return a clean error the model can fix).
 *  - `reasoning` items → NOT surfaced in canonical text. They replay via
 *    `provider_state` so the model gets to see them next turn but the
 *    operator's comment-collection pass doesn't.
 *  - All other output item types (web search calls, file search, computer
 *    tool, etc.) → silently ignored. We don't enable those tools today; if
 *    they ever appear, they're meant for OpenAI-side bookkeeping and will
 *    round-trip via `provider_state`.
 *
 * Stop reason normalization:
 *  - Any tool_calls present → `'tool_calls'`
 *  - `response.status === 'completed'` → `'end_turn'`
 *  - `response.status === 'incomplete'` with
 *    `incomplete_details.reason === 'max_output_tokens'` → `'max_tokens'`
 *  - Anything else (in_progress, failed, content_filter incomplete, …) →
 *    `'other'`
 *  - Refusal forces `'end_turn'` regardless.
 *
 * Usage mapping:
 *  - Cache fields omitted when 0 (parity with the Anthropic adapter's
 *    "noisy cache_r=0 line" reasoning). `cache_creation_tokens` is never
 *    set — OpenAI doesn't charge for cache writes and doesn't surface them.
 *
 * `provider_state` is set to the FULL `response.output` array so the next
 * turn's request can splat it back into `input[]` (see
 * `canonicalMessagesToResponsesInput` provider_state branch). Anthropic's
 * adapter leaves this undefined; OpenAI is the only consumer.
 */
export function responsesResponseToCanonical(
  response: OpenAI.Responses.Response,
): CompleteResponse {
  let text = '';
  const tool_calls: CanonicalToolCall[] = [];
  let refused = false;

  for (const item of response.output) {
    if (item.type === 'message' && item.role === 'assistant') {
      // ResponseOutputMessage.content is Array<output_text | refusal>.
      // Once a refusal lands in the same message, the refusal text is
      // authoritative — both any prior `output_text` preamble AND any
      // subsequent `output_text` blocks are discarded. Surfacing
      // "preamble + [refused] ..." in canonical text would be confusing
      // for downstream consumers (the runner logs it as the assistant's
      // visible content). See PR #20 self-review minor #3300641271.
      for (const content of item.content) {
        if (content.type === 'output_text') {
          if (!refused) text += content.text;
        } else if (content.type === 'refusal') {
          refused = true;
          text = `[refused] ${content.refusal}`;
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        // Fire-and-forget warn: logger.warn returns Promise<void> that we
        // intentionally don't await — the function stays synchronous so
        // callers don't pay an async hop on the happy path (PR #20 self-
        // review minor #3300641273). The warn flushes through @actions/core
        // before the runner's next await; in the local-CLI path it's a
        // console.warn that flushes synchronously.
        void logger.warn(
          `[openai-provider] model=${response.model} produced malformed JSON for tool=${item.name} call_id=${item.call_id}; surfacing as empty-args call`,
        );
        args = {};
      }
      tool_calls.push({ id: item.call_id, name: item.name, arguments: args });
      continue;
    }

    // reasoning items + every other output item type round-trip via
    // provider_state and are not surfaced in canonical text. No-op here.
  }

  // Stop reason.
  let stop_reason: StopReason;
  if (refused) {
    stop_reason = 'end_turn';
  } else if (tool_calls.length > 0) {
    stop_reason = 'tool_calls';
  } else {
    switch (response.status) {
      case 'completed':
        stop_reason = 'end_turn';
        break;
      case 'incomplete':
        stop_reason =
          response.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : 'other';
        break;
      default:
        stop_reason = 'other';
    }
  }

  // Usage.
  const usage: CanonicalUsage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  const cacheRead = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  if (cacheRead > 0) usage.cache_read_tokens = cacheRead;
  const reasoning = response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  if (reasoning > 0) usage.reasoning_tokens = reasoning;
  // cache_creation_tokens is intentionally left unset — OpenAI doesn't bill
  // for cache writes and the canonical type allows undefined.

  return {
    text,
    tool_calls,
    stop_reason,
    usage,
    // Splat target for the next turn's input replay (carries encrypted
    // reasoning items for o-series).
    provider_state: response.output,
  };
}
