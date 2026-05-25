/**
 * Custom tool-use loop using @anthropic-ai/sdk directly.
 *
 * Replaces the higher-level Claude Agent SDK because of upstream bugs with
 * in-process MCP servers (duplicate tool_use IDs, missing tool_results in
 * subsequent API requests). This gives us full control and visibility.
 *
 * The loop:
 *   1. Send messages + tools + system prompt to Claude
 *   2. Parse the assistant response for text and tool_use blocks
 *   3. For each tool_use, run the handler from our tool definition
 *   4. Append the tool_result blocks to the conversation
 *   5. Repeat until Claude stops calling tools, post_summary is called, or
 *      a limit is hit
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { AgentError, BudgetError } from '../util/errors.js';
import { Budget } from '../util/budget.js';
import { logger } from '../util/logger.js';
import { pricingForModel } from '../util/pricing.js';
import { makeGetPrDiffTool } from '../tools/get-pr-diff.js';
import { makeGetPrMetadataTool } from '../tools/get-pr-metadata.js';
import { makeGrepRepoAtRefTool } from '../tools/grep-repo-at-ref.js';
import { makeListChangedFilesTool } from '../tools/list-changed-files.js';
import { makePostInlineCommentTool } from '../tools/post-inline-comment.js';
import { makePostSummaryTool } from '../tools/post-summary.js';
import { makeReadFileAtRefTool } from '../tools/read-file-at-ref.js';
import { makeReadRepoContextFileTool } from '../tools/read-repo-context-file.js';
import { makeSkipFileTool } from '../tools/skip-file.js';
import type { ToolDeps } from '../tools/types.js';

export interface RunAgentInput {
  deps: ToolDeps;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTurns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  apiKey: string;
  abortController?: AbortController;
}

export interface RunAgentResult {
  ended: 'summary_posted' | 'max_turns' | 'budget_exceeded' | 'aborted' | 'error';
  error?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

type AnthropicTool = Anthropic.Tool;

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const budget = new Budget({
    maxTurns: input.maxTurns,
    warnFraction: 0.8,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });

  const tools = buildToolDefinitions(input.deps);
  // Mark the LAST tool with cache_control: tools don't change across turns,
  // so this breakpoint caches the full tool block (~2-3K tokens of schemas)
  // at the ephemeral cache-read rate instead of re-billing the full input
  // rate on every turn. With `system` already cached and `messages` cached
  // separately below, we use 3 of the 4 cache_control breakpoints allowed
  // per request.
  const anthropicTools: AnthropicTool[] = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));

  await logger.info(`Agent ready: model=${input.model}, tools=${tools.length}, max_turns=${input.maxTurns}`);

  const client = new Anthropic({ apiKey: input.apiKey });

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: input.userPrompt },
  ];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let ended: RunAgentResult['ended'] = 'error';
  let lastError: string | undefined;

  try {
    while (true) {
      if (input.abortController?.signal.aborted) {
        ended = 'aborted';
        break;
      }
      budget.startTurn();
      turns = budget.snapshot().turns;

      // Slide a cache_control breakpoint forward onto the latest user message
      // each turn. This caches the entire prior conversation prefix (assistant
      // turns + tool results, which can hold 100KB diffs and 500-line file
      // reads) so we don't re-bill it at full input rate on every turn.
      markLatestMessageForCaching(messages);

      const response = await client.messages.create(
        {
          model: input.model,
          max_tokens: 8192,
          system: [
            { type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } },
          ],
          messages,
          tools: anthropicTools,
        },
        input.abortController ? { signal: input.abortController.signal } : undefined,
      );

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;

      try {
        budget.addUsage(
          billableInputTokensForBudget(response.usage),
          response.usage.output_tokens,
        );
      } catch (err) {
        lastError = (err as Error).message;
        ended = 'budget_exceeded';
        break;
      }

      // Log text blocks and tool_use blocks
      const assistantBlocks = response.content;
      const toolUseBlocks = assistantBlocks.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      const textBlocks = assistantBlocks.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );

      for (const t of textBlocks) {
        if (t.text.trim().length > 0) {
          await logger.info(`[turn ${turns}] (assistant): ${t.text.slice(0, 500)}`);
        }
      }
      for (const u of toolUseBlocks) {
        await logger.info(`[turn ${turns}] → ${u.name}`);
      }

      messages.push({ role: 'assistant', content: assistantBlocks });

      // End conditions
      if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
        ended = input.deps.aggregator.hasSummary() ? 'summary_posted' : 'max_turns';
        break;
      }

      // Execute tool_use blocks; collect tool_result blocks for the next user message
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const u of toolUseBlocks) {
        const tool = tools.find((t) => t.name === u.name);
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: u.id,
            is_error: true,
            content: `Unknown tool: ${u.name}`,
          });
          continue;
        }
        try {
          const args = (u.input ?? {}) as Record<string, unknown>;
          const result = await tool.handler(args);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: u.id,
            content: result,
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: u.id,
            is_error: true,
            content: `Tool error: ${(err as Error).message}`,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      // Terminate after summary
      if (input.deps.aggregator.hasSummary()) {
        ended = 'summary_posted';
        break;
      }
    }
  } catch (err) {
    if (err instanceof BudgetError) {
      ended = 'budget_exceeded';
      lastError = err.message;
    } else if (err instanceof Error && err.name === 'AbortError') {
      ended = 'aborted';
      lastError = err.message;
    } else {
      lastError = err instanceof Error ? err.message : String(err);
      throw new AgentError(`Agent run failed: ${lastError}`, { cause: err });
    }
  }

  // Compute cost using the active model's pricing. If the model id isn't in
  // our table (operator override to an experimental model), warn and fall
  // back to Sonnet rates so cost_usd stays populated — we can't refuse here
  // because the API spend has already happened.
  //
  // Three-level resolution avoids a NaN-cost failure mode if the pricing
  // table is ever pruned of the Sonnet fallback key during a future update:
  // try the active model → try the Sonnet key by name → fall through to
  // inline Sonnet rates (last-resort, kept in sync by hand). If we lose
  // BOTH the active-model lookup and the Sonnet table entry, the inline
  // rates keep cost_usd in the right order of magnitude rather than logging
  // $NaN and silently corrupting downstream budget alerts.
  const rawPricing = pricingForModel(input.model);
  if (rawPricing === undefined) {
    await logger.warn(
      `No pricing entry for model "${input.model}" — cost_usd computed with Sonnet rates as a fallback. Update src/util/pricing.ts to include this model.`,
    );
  }
  const pricing = rawPricing ?? pricingForModel('claude-sonnet-4-6') ?? {
    input: 3,
    output: 15,
    cache_creation: 3.75,
    cache_read: 0.3,
  };
  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  const cacheCost =
    (cacheCreationTokens * pricing.cache_creation) / 1_000_000 +
    (cacheReadTokens * pricing.cache_read) / 1_000_000;
  const costUsd = inputCost + outputCost + cacheCost;

  await logger.info(
    `Agent run ended: ${ended}, turns=${turns}, in=${inputTokens} (cache_r=${cacheReadTokens}, cache_c=${cacheCreationTokens}), out=${outputTokens}, cost=$${costUsd.toFixed(4)}`,
  );
  if (lastError) await logger.warn(`Last error: ${lastError}`);

  return {
    ended,
    ...(lastError !== undefined ? { error: lastError } : {}),
    turns,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

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

function markLastBlockForCaching(message: Anthropic.MessageParam): void {
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const lastBlock = message.content[message.content.length - 1];
  if (lastBlock === undefined || typeof lastBlock !== 'object' || lastBlock === null) return;
  (lastBlock as { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' };
}

/**
 * Bridge MCP tool definitions (from the tools/ modules) into our internal
 * shape with JSON Schema + a plain handler that returns a string.
 */
function buildToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const mcpTools = [
    makeGetPrMetadataTool(deps),
    makeListChangedFilesTool(deps),
    makeGetPrDiffTool(deps),
    makeReadFileAtRefTool(deps),
    makeGrepRepoAtRefTool(deps),
    makeReadRepoContextFileTool(deps),
    makePostInlineCommentTool(deps),
    makePostSummaryTool(deps),
    makeSkipFileTool(deps),
  ];

  return mcpTools.map((mcp) => {
    const zodSchema = z.object(mcp.inputSchema as z.ZodRawShape);
    const rawJson = zodToJsonSchema(zodSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    // Strip $schema (API doesn't need it) and force `type: 'object'`.
    if ('$schema' in rawJson) delete rawJson['$schema'];
    const inputSchema: Anthropic.Tool.InputSchema = {
      type: 'object',
      properties: (rawJson.properties as Record<string, unknown>) ?? {},
      ...(Array.isArray(rawJson.required) ? { required: rawJson.required as string[] } : {}),
    };
    return {
      name: mcp.name,
      description: mcp.description,
      input_schema: inputSchema,
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const result = await (mcp.handler as (a: unknown, e: unknown) => Promise<unknown>)(args, undefined);
        const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
        return content
          .map((b) => (b.type === 'text' ? b.text ?? '' : JSON.stringify(b)))
          .join('\n');
      },
    };
  });
}
