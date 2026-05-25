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
import { costFromUsage, pricingForModel } from '../util/pricing.js';
import { markLatestMessageForCaching } from '../llm/anthropic-provider.js';
import { makeGetPrDiffTool } from '../tools/get-pr-diff.js';
import { makeGetPrMetadataTool } from '../tools/get-pr-metadata.js';
import { makeGrepRepoAtRefTool } from '../tools/grep-repo-at-ref.js';
import { makeListChangedFilesTool } from '../tools/list-changed-files.js';
import { makePostInlineCommentTool } from '../tools/post-inline-comment.js';
import { makePostSummaryTool } from '../tools/post-summary.js';
import { makeReadFileAtRefTool } from '../tools/read-file-at-ref.js';
import { makeReadRepoContextFileTool } from '../tools/read-repo-context-file.js';
import { makeSkipFileTool } from '../tools/skip-file.js';
import { makeWorkerCheckUsageClaimTool } from '../tools/worker-check-usage-claim.js';
import type { ToolDeps } from '../tools/types.js';
import { renderPreflightSection, runPreflight } from './preflight.js';
import { WorkerClient } from './worker.js';

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
  /**
   * Cost breakdown per model used during this run. With worker delegation
   * enabled, the parent Sonnet driver and any Haiku worker calls accumulate
   * separately so downstream reporting can show the Sonnet/Haiku split. Sum
   * equals `costUsd` (modulo float).
   */
  perModelCost: Array<{
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>;
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

  const client = new Anthropic({ apiKey: input.apiKey });

  // Wire optional worker delegation. Sonnet's tool list gets a tenth tool
  // (worker_check_usage_claim) only when the flag is on — opt-out repos
  // keep the v0.2.x tool set and behavior verbatim.
  const workerConfig = input.deps.config.experimental.worker_delegation;
  const worker: WorkerClient | undefined = workerConfig.enabled
    ? new WorkerClient(client, budget, workerConfig.worker_model)
    : undefined;

  const fullDeps: ToolDeps = { ...input.deps, ...(worker !== undefined ? { worker } : {}) };
  const tools = buildToolDefinitions(fullDeps);
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

  await logger.info(
    `Agent ready: model=${input.model}, tools=${tools.length}, max_turns=${input.maxTurns}` +
      (worker !== undefined ? `, worker=${workerConfig.worker_model}` : ''),
  );

  // Pre-flight Haiku skim: when worker delegation is enabled, summarize the
  // diff into a structured candidate list BEFORE Sonnet's loop starts. The
  // big win is that Sonnet's initial user prompt now carries the focused
  // candidate list instead of needing to wide-scan the full diff through
  // get_pr_diff (which would then sit in the cache pool for every turn).
  // On failure, we log and continue with the original prompt — pre-flight
  // is an optimization, not a correctness gate.
  let userPrompt = input.userPrompt;
  let turns = 0;
  let ended: RunAgentResult['ended'] = 'error';
  let lastError: string | undefined;
  // Run preflight inside the same try that handles the main loop so a
  // BudgetError thrown from the Haiku call (e.g. tight maxInputTokens cap,
  // or a very large diff) lands in 'budget_exceeded' instead of escaping
  // runAgent and turning into an orchestrator-level failure.
  let preflightBudgetExceeded = false;
  if (worker !== undefined) {
    try {
      const analysis = await runPreflight({
        client,
        budget,
        model: workerConfig.worker_model,
        prContext: input.deps.prContext,
      });
      if (analysis !== null) {
        userPrompt =
          renderPreflightSection(analysis, input.deps.prContext.files) +
          '\n\n' +
          userPrompt;
      }
    } catch (err) {
      if (err instanceof BudgetError) {
        ended = 'budget_exceeded';
        lastError = err.message;
        preflightBudgetExceeded = true;
      } else {
        // Any other error during preflight is non-fatal — preflight is an
        // optimization, not a correctness gate. Log and continue with the
        // unmodified user prompt; the main loop still runs normally.
        await logger.warn(
          `Pre-flight failed with non-budget error: ${(err as Error).message}. Continuing without pre-analysis.`,
        );
      }
    }
  }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  try {
    if (preflightBudgetExceeded) {
      // Skip the main loop — the budget is already exhausted. Fall through
      // to cost reporting below.
      throw new BudgetError(lastError ?? 'Pre-flight exhausted budget');
    }
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
          // Mid-range temperature: trims the wide sampling at the SDK default
          // (1.0) that produced run-to-run variance on identical diffs, while
          // staying high enough to preserve recall. v0.2.1 tried 0.1 and saw
          // recall drop from 5/7 → 3/7 matches on the golden-eval set (one
          // case missed entirely, another hit the turn cap on dead-end
          // investigation). 0.5 restored 5/7 recall with cost unchanged.
          temperature: 0.5,
          system: [
            { type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } },
          ],
          messages,
          tools: anthropicTools,
        },
        input.abortController ? { signal: input.abortController.signal } : undefined,
      );

      try {
        budget.addUsage(input.model, response.usage);
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
          // BudgetError must escape this catch so the outer try (line ~235)
          // can flip `ended` to 'budget_exceeded' and stop the loop.
          // Swallowing it here would let the loop keep dispatching tools
          // until max_turns trips — masking the cap and over-spending.
          // Other tool errors are recoverable: surface them to the agent as
          // is_error tool_results so it can self-correct.
          if (err instanceof BudgetError) throw err;
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

  // Compute cost per model. Models the pricing table doesn't recognize
  // (operator overrides, experimental aliases) fall back to Sonnet rates
  // inside costFromUsage — cost_usd stays populated rather than failing
  // hard, because the API spend has already happened.
  const perModelCost = budget.snapshotByModel().map(({ model, usage }) => ({
    model,
    costUsd: costFromUsage(model, usage),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
  }));

  for (const m of perModelCost) {
    if (pricingForModel(m.model) === undefined) {
      await logger.warn(
        `No pricing entry for model "${m.model}" — cost computed with Sonnet rates as a fallback. Update src/util/pricing.ts to include this model.`,
      );
    }
  }

  const costUsd = perModelCost.reduce((sum, m) => sum + m.costUsd, 0);
  const totals = budget.snapshot();

  await logger.info(
    `Agent run ended: ${ended}, turns=${turns}, in=${totals.inputTokens} (cache_r=${totals.cacheReadTokens}, cache_c=${totals.cacheCreationTokens}), out=${totals.outputTokens}, cost=$${costUsd.toFixed(4)}`,
  );
  if (perModelCost.length > 1) {
    for (const m of perModelCost) {
      await logger.info(
        `  ${m.model}: $${m.costUsd.toFixed(4)} (in=${m.inputTokens}, cache_r=${m.cacheReadTokens}, cache_c=${m.cacheCreationTokens}, out=${m.outputTokens})`,
      );
    }
  }
  if (lastError) await logger.warn(`Last error: ${lastError}`);

  return {
    ended,
    ...(lastError !== undefined ? { error: lastError } : {}),
    turns,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd,
    perModelCost,
  };
}

/**
 * Bridge MCP tool definitions (from the tools/ modules) into our internal
 * shape with JSON Schema + a plain handler that returns a string.
 *
 * When `deps.worker` is present (worker_delegation flag enabled), an extra
 * `worker_check_usage_claim` tool joins the list. Tool order does not affect
 * Sonnet's choice but does affect the cache_control breakpoint placement —
 * the LAST tool gets the breakpoint, so we keep the worker tool at the end
 * so its addition doesn't bust the existing cache anchor.
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
    ...(deps.worker !== undefined ? [makeWorkerCheckUsageClaimTool(deps)] : []),
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
