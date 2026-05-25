/**
 * Provider-agnostic tool-use loop.
 *
 * The runner speaks only the canonical message/tool/response vocabulary
 * defined in `src/llm/types.ts`. Vendor-specific shapes (cache_control,
 * Responses-API `provider_state` replay, Anthropic vs OpenAI usage fields)
 * live inside each `LLMProvider` adapter — this file knows none of it.
 *
 * Loop:
 *   1. Resolve the provider for the configured model (Anthropic / OpenAI)
 *   2. Optional Anthropic-only pre-flight Haiku skim feeds Sonnet's first
 *      user prompt with a structured candidate list (worker delegation flag).
 *   3. Send messages + tools + system prompt via `provider.complete()`
 *   4. Read canonical `text` and `tool_calls` from the response
 *   5. Execute each tool_call and append a canonical `tool` message
 *   6. Repeat until the model stops calling tools, `post_summary` is called,
 *      or a limit (turns / tokens / abort) is hit
 *
 * Why we hand-rolled this loop (not the Claude Agent SDK): the SDK had
 * upstream bugs with in-process MCP servers — duplicate `tool_use` IDs and
 * missing tool_results in subsequent requests. Owning the loop also gives us
 * full visibility into the canonical-message round trip per turn, which made
 * the provider abstraction tractable.
 *
 * Note on `experimental.worker_delegation`: pre-flight Haiku + the worker
 * tool both call `@anthropic-ai/sdk` directly (they're hardcoded to Haiku).
 * Worker delegation is Anthropic-only — when the resolved provider is
 * OpenAI, the worker is silently disabled with a warning rather than
 * erroring the run.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { AgentError, BudgetError } from '../util/errors.js';
import { Budget } from '../util/budget.js';
import { logger } from '../util/logger.js';
import { costFromUsage, pricingForModel } from '../util/pricing.js';
import {
  createProvider,
  type CanonicalMessage,
  type CanonicalTool,
  type LLMProvider,
  type ProviderId,
} from '../llm/index.js';
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

/**
 * Default sampling temperature. PR #14 pinned this at 0.1 and saw recall
 * drop from 5/7 → 3/7 on the golden-eval set; PR #15 settled on 0.5 (recall
 * restored at no cost increase). Treat as a tuned constant — change only
 * with eval evidence.
 */
const DEFAULT_TEMPERATURE = 0.5;

/**
 * Input to `runAgent`. The plan called for a nested
 * `providerInput: {modelId, apiKey, providerHint?}` wrapper, but we keep
 * these fields flat at the top level: each has an independent provenance
 * in the orchestrator (model from config, apiKey from env, providerHint
 * from config override) and nesting would just add boilerplate at the
 * call site for no readability gain.
 */
export interface RunAgentInput {
  deps: ToolDeps;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTurns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** API key for the resolved provider (orchestrator picks anthropic vs openai). */
  apiKey: string;
  /**
   * Optional override for provider routing. Omit to let `createProvider()`
   * infer from the model id (`claude-*` → anthropic, `gpt-*`/`o<digit>` →
   * openai). Set when operator config wants to force a provider against the
   * inferred default — e.g. routing a `claude-*` id through a compatibility
   * shim, or pinning explicit provider selection in `.code-review.yml`.
   */
  providerHint?: ProviderId;
  /**
   * Sampling temperature. Defaults to `DEFAULT_TEMPERATURE` (0.5) when
   * omitted — see that constant's JSDoc for the recall/cost rationale.
   */
  temperature?: number;
  abortController?: AbortController;
  /**
   * Optional override for provider instantiation. Production omits this and
   * `createProvider` is used. Test harnesses (e.g. `scripts/eval/orchestrator-adapter.ts`)
   * inject a scripted `FakeProvider` here instead of mocking the underlying
   * vendor SDK at module scope — same shape works for any provider.
   */
  providerFactory?: (input: {
    modelId: string;
    apiKey: string;
    providerHint?: ProviderId;
  }) => LLMProvider;
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

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: CanonicalTool['input_schema'];
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const budget = new Budget({
    maxTurns: input.maxTurns,
    warnFraction: 0.8,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });

  const provider = (input.providerFactory ?? createProvider)({
    modelId: input.model,
    apiKey: input.apiKey,
    ...(input.providerHint !== undefined ? { providerHint: input.providerHint } : {}),
  });

  // Wire optional worker delegation. ONLY available when the resolved
  // provider is Anthropic — pre-flight Haiku and the worker tool both use
  // `@anthropic-ai/sdk` directly (hardcoded to Haiku). OpenAI consumers
  // get a warning and the worker is silently disabled for the run.
  const workerConfig = input.deps.config.experimental.worker_delegation;
  let worker: WorkerClient | undefined;
  if (workerConfig.enabled) {
    if (provider.id !== 'anthropic') {
      await logger.warn(
        `experimental.worker_delegation.enabled is true but resolved provider is ${provider.id}. Worker delegation is Anthropic-only; disabling for this run.`,
      );
    } else {
      const anthropicClient = new Anthropic({ apiKey: input.apiKey });
      worker = new WorkerClient(anthropicClient, budget, workerConfig.worker_model);
    }
  }

  const fullDeps: ToolDeps = { ...input.deps, ...(worker !== undefined ? { worker } : {}) };
  const tools = buildToolDefinitions(fullDeps);

  // Strip handlers for the provider call — adapters only need the schema
  // surface. The handler lookup stays local to this file (the `tools.find`
  // in the tool-execution branch below).
  const canonicalTools: CanonicalTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const temperature = input.temperature ?? DEFAULT_TEMPERATURE;

  await logger.info(
    `Agent ready: provider=${provider.id}, model=${input.model}, tools=${tools.length}, max_turns=${input.maxTurns}` +
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
      // Pre-flight needs its own Anthropic client. Constructing here keeps
      // the dependency local to the conditional pre-flight branch (a one-shot
      // — sharing the worker's client would couple two independent code
      // paths for negligible savings).
      const preflightClient = new Anthropic({ apiKey: input.apiKey });
      const analysis = await runPreflight({
        client: preflightClient,
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

  const messages: CanonicalMessage[] = [
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

      const response = await provider.complete(messages, canonicalTools, {
        model: input.model,
        maxOutputTokens: 8192,
        system: input.systemPrompt,
        // Centralized via DEFAULT_TEMPERATURE up top — see that constant's
        // JSDoc for the recall/cost history. The OpenAI adapter drops the
        // field automatically for o-series reasoning models that reject it.
        temperature,
        ...(input.abortController ? { abortSignal: input.abortController.signal } : {}),
      });

      try {
        // PR #17's Budget owns the per-model accumulation + billable formula.
        // Its `ModelUsage` interface uses the Anthropic-SDK snake_case names
        // (`cache_creation_input_tokens`, `cache_read_input_tokens`) for JSON
        // back-compat on persisted eval records. Translate the canonical
        // shape (no `_input_` infix) at this boundary.
        budget.addUsage(input.model, {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_tokens ?? 0,
          cache_read_input_tokens: response.usage.cache_read_tokens ?? 0,
        });
      } catch (err) {
        lastError = (err as Error).message;
        ended = 'budget_exceeded';
        break;
      }

      const toolCalls = response.tool_calls;
      const text = response.text;

      if (text.trim().length > 0) {
        await logger.info(`[turn ${turns}] (assistant): ${text.slice(0, 500)}`);
      }
      for (const call of toolCalls) {
        await logger.info(`[turn ${turns}] → ${call.name}`);
      }

      const assistantMsg: CanonicalMessage = {
        role: 'assistant',
        // Always emit `text` — empty string round-trips fine through both
        // adapters (Anthropic skips zero-length text blocks; OpenAI skips
        // zero-length output_text items) and saves the caller from a
        // conditional spread.
        text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(response.provider_state !== undefined
          ? { provider_state: response.provider_state }
          : {}),
      };
      messages.push(assistantMsg);

      // End conditions
      if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
        ended = input.deps.aggregator.hasSummary() ? 'summary_posted' : 'max_turns';
        break;
      }

      // Execute tool_calls; push each result as its own canonical `tool`
      // message. The Anthropic adapter groups consecutive `tool` messages
      // into one user-wrapped batch internally (the API requires it); the
      // OpenAI Responses adapter emits them as separate `function_call_output`
      // items. Either way, the runner just appends one tool message per call.
      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        let result: string;
        let isError = false;
        if (!tool) {
          result = `Unknown tool: ${call.name}`;
          isError = true;
        } else {
          try {
            result = await tool.handler(call.arguments);
          } catch (err) {
            // BudgetError must escape this catch so the outer try
            // can flip `ended` to 'budget_exceeded' and stop the loop.
            // Swallowing it here would let the loop keep dispatching tools
            // until max_turns trips — masking the cap and over-spending.
            // Other tool errors are recoverable: surface them to the agent as
            // is_error tool_results so it can self-correct.
            if (err instanceof BudgetError) throw err;
            result = `Tool error: ${(err as Error).message}`;
            isError = true;
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
          ...(isError ? { is_error: true } : {}),
        });
      }

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
 * the LAST tool gets the breakpoint (inside the AnthropicProvider adapter),
 * so we keep the worker tool at the end so its addition doesn't bust the
 * existing cache anchor.
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
    const inputSchema: CanonicalTool['input_schema'] = {
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
