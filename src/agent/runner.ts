/**
 * Drives the Claude Agent SDK query loop. Streams events to the action log,
 * tracks budget, and returns when the agent calls post_summary (or hits limits).
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentError, BudgetError } from '../util/errors.js';
import { Budget } from '../util/budget.js';
import { logger } from '../util/logger.js';
import { buildToolServer, MCP_SERVER_NAME, QUALIFIED_TOOL_NAMES, type ToolDeps } from '../tools/index.js';

export interface RunAgentInput {
  deps: ToolDeps;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTurns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Optional abort signal for external cancellation (timeouts). */
  abortController?: AbortController;
}

export interface RunAgentResult {
  /** How the run ended. */
  ended: 'summary_posted' | 'max_turns' | 'budget_exceeded' | 'aborted' | 'error';
  /** Last error if any. */
  error?: string;
  /** Number of agent turns consumed. */
  turns: number;
  /** Total tokens used. */
  inputTokens: number;
  outputTokens: number;
  /** USD cost (from the result message if available). */
  costUsd: number;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const budget = new Budget({
    maxTurns: input.maxTurns,
    warnFraction: 0.8,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });

  const mcpServer = buildToolServer(input.deps);

  const options: Options = {
    systemPrompt: input.systemPrompt,
    model: input.model,
    maxTurns: input.maxTurns,
    mcpServers: { [MCP_SERVER_NAME]: mcpServer },
    allowedTools: QUALIFIED_TOOL_NAMES,
    tools: [],
    cwd: input.deps.workspaceDir,
    ...(input.abortController ? { abortController: input.abortController } : {}),
  };

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let ended: RunAgentResult['ended'] = 'error';
  let lastError: string | undefined;

  try {
    const stream = query({ prompt: input.userPrompt, options });

    for await (const msg of stream) {
      await handleMessage(msg, {
        budget,
        onTurn: () => {
          turns += 1;
        },
        onUsage: (i, o) => {
          inputTokens += i;
          outputTokens += o;
        },
      });

      if (msg.type === 'result' && msg.subtype === 'success') {
        const u = msg.usage;
        if (u) {
          inputTokens = u.input_tokens ?? inputTokens;
          outputTokens = u.output_tokens ?? outputTokens;
        }
        costUsd = msg.total_cost_usd ?? 0;
        turns = msg.num_turns ?? turns;
        // The agent ended normally — check whether post_summary was called.
        ended = input.deps.aggregator.hasSummary() ? 'summary_posted' : 'max_turns';
        break;
      }
    }

    // If the stream ended without a result message but a summary was posted, count it.
    if (ended === 'error' && input.deps.aggregator.hasSummary()) {
      ended = 'summary_posted';
    }
  } catch (err) {
    if (err instanceof BudgetError) {
      ended = 'budget_exceeded';
      lastError = err.message;
    } else if (err instanceof Error && err.name === 'AbortError') {
      ended = 'aborted';
      lastError = err.message;
    } else {
      ended = 'error';
      lastError = err instanceof Error ? err.message : String(err);
      throw new AgentError(`Agent run failed: ${lastError}`, { cause: err });
    }
  }

  await logger.info(
    `Agent run ended: ${ended}, turns=${turns}, in=${inputTokens}, out=${outputTokens}, cost=$${costUsd.toFixed(4)}`,
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

interface HandleContext {
  budget: Budget;
  onTurn: () => void;
  onUsage: (input: number, output: number) => void;
}

async function handleMessage(msg: SDKMessage, ctx: HandleContext): Promise<void> {
  if (msg.type === 'assistant') {
    ctx.onTurn();
    try {
      ctx.budget.startTurn();
    } catch (err) {
      // Re-throw budget errors; the outer loop converts to ended state.
      throw err;
    }

    const usage = msg.message.usage;
    if (usage) {
      const inTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      const outTokens = usage.output_tokens ?? 0;
      ctx.onUsage(inTokens, outTokens);
      try {
        ctx.budget.addUsage(inTokens, outTokens);
      } catch (err) {
        throw err;
      }
    }

    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        await logger.info(`[turn ${ctx.budget.snapshot().turns}] → ${block.name}`);
      } else if (block.type === 'text' && block.text.trim().length > 0) {
        await logger.debug(`[turn ${ctx.budget.snapshot().turns}] (assistant text): ${block.text.slice(0, 200)}`);
      }
    }
  } else if (msg.type === 'user') {
    // Tool result messages — log briefly.
    if (Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          const tu = (block as { tool_use_id?: string }).tool_use_id ?? '';
          await logger.debug(`tool_result for ${tu}`);
        }
      }
    }
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    await logger.info(
      `Agent initialized: model=${(msg as unknown as { model?: string }).model ?? 'unknown'}, cwd=${msg.cwd}, mcp_servers=${msg.mcp_servers.map((s) => `${s.name}(${s.status})`).join(',')}`,
    );
  }
}
