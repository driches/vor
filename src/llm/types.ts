/**
 * Provider-agnostic, canonical types shared by every LLM adapter (Anthropic,
 * OpenAI, future). The runner and tool layer speak only this vocabulary;
 * vendor-shaped payloads are confined to each provider's adapter.
 */

/** Stable id for routing config + selecting an adapter at runtime. */
export type ProviderId = 'anthropic' | 'openai';

/**
 * One message in the conversation transcript. The shape varies by role
 * because each role has different fields the runner cares about:
 *  - `user`: a plain string prompt (we never need structured user content
 *    yet — file content gets injected as text).
 *  - `assistant`: optional `text` (visible reasoning / chat output) and
 *    optional `tool_calls` (the model wants the runner to invoke tools).
 *    May carry `provider_state` (see field doc) for stateless replay.
 *  - `tool`: a tool result the runner appends after executing a call.
 */
export type CanonicalMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      text?: string;
      tool_calls?: CanonicalToolCall[];
      /**
       * Opaque, provider-specific replay blob. The runner round-trips this
       * back into the next request unchanged and never interprets it.
       * OpenAI Responses API populates it with reasoning items so a follow-up
       * stateless call can preserve the model's chain-of-thought across
       * tool calls; Anthropic currently sets nothing here.
       */
      provider_state?: unknown;
    }
  | { role: 'tool'; tool_call_id: string; content: string; is_error?: boolean };

/** A single tool invocation the model has requested. */
export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The tool registry shape passed to every provider. Mirrors Anthropic's
 * `input_schema` because that's the simpler JSON-Schema-subset surface;
 * the OpenAI adapter rewrites it into Responses-API shape internally.
 */
export interface CanonicalTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/** Per-turn knobs the runner passes into every `complete()` call. */
export interface CompleteOptions {
  model: string;
  maxOutputTokens: number;
  system: string;
  temperature?: number;
  abortSignal?: AbortSignal;
}

/**
 * Token accounting normalized across vendors. Canonical naming drops the
 * `_input_` infix from Anthropic's `cache_read_input_tokens` /
 * `cache_creation_input_tokens` so both providers can populate the same
 * shape without an awkward rename.
 */
export interface CanonicalUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * Tokens served from a cache hit (cheaper than fresh `input_tokens`).
   * Both Anthropic and OpenAI report this; pricing differs but the field
   * name is shared.
   */
  cache_read_tokens?: number;
  /**
   * Tokens written into the prompt cache. Anthropic-only — OpenAI's cache
   * writes are free and not separately surfaced.
   */
  cache_creation_tokens?: number;
  /**
   * Hidden chain-of-thought tokens billed as output, OpenAI o-series only.
   * Already included in `output_tokens` — surfaced separately for telemetry,
   * not for double-counting in cost math.
   */
  reasoning_tokens?: number;
}

/**
 * Why the provider stopped emitting tokens this turn. Normalized to a small
 * set the runner switches on; provider-specific values get collapsed:
 *  - `end_turn`: the model is done and produced a final assistant message
 *  - `tool_calls`: the model wants tools invoked before continuing
 *  - `max_tokens`: hit `maxOutputTokens` mid-stream
 *  - `other`: anything else (refusal, safety stop, content filter, etc.)
 */
export type StopReason = 'end_turn' | 'tool_calls' | 'max_tokens' | 'other';

/** One turn's worth of response normalized for the runner. */
export interface CompleteResponse {
  text: string;
  tool_calls: CanonicalToolCall[];
  stop_reason: StopReason;
  usage: CanonicalUsage;
  /** See CanonicalMessage.assistant.provider_state — same opaque blob. */
  provider_state?: unknown;
}

/**
 * Provider adapter contract. Every concrete adapter (Anthropic, OpenAI)
 * implements this so the runner has exactly one code path regardless of
 * which vendor is configured.
 */
export interface LLMProvider {
  readonly id: ProviderId;
  complete(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: CompleteOptions,
  ): Promise<CompleteResponse>;
  /**
   * Returns the input-token count that should count against the runner's
   * `max_input_tokens` budget gate. Provider-specific math:
   *  - Anthropic excludes `cache_read_tokens` (per PR #13) so the default
   *    500K budget doesn't fire on turn 1 of a cached run.
   *  - OpenAI subtracts cached tokens for the same reason.
   * Centralizing this on the provider keeps the runner's budget gate
   * vendor-neutral.
   */
  billableInputTokensForBudget(usage: CanonicalUsage): number;
}
