/**
 * Worker client — single-shot Haiku calls invoked by Sonnet's tool handlers.
 *
 * Workers do ONE thing: receive text, return JSON. No tool loop, no nested
 * delegation. The simplicity is load-bearing — a worker with its own agentic
 * surface re-creates the failure modes we localize Sonnet to handle (Haiku
 * tested at 28% recall as a drop-in main agent, so it's NOT a decision-maker;
 * it's a fact-extractor).
 *
 * All worker spend is recorded against the same `Budget` instance the parent
 * uses, so a Sonnet+Haiku run's cap behavior is unchanged from a Sonnet-only
 * run — the input cap counts billable input across both models.
 *
 * Verification discipline (the "Sonnet checks the work" half of the design)
 * lives in src/agent/validate-comment.ts, not here. This module only produces
 * structured hints that Sonnet may or may not act on.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { Budget } from '../util/budget.js';
import { logger } from '../util/logger.js';

export interface WorkerInvocation<Schema extends z.ZodTypeAny> {
  /** Identifier used in logs only — does not affect prompting. */
  task: string;
  systemPrompt: string;
  userPrompt: string;
  /** Cap on the worker's response. 1024 is plenty for structured JSON. */
  maxTokens: number;
  /** Zod schema the response JSON must match. Validation failure → throw. */
  responseSchema: Schema;
}

export interface WorkerResult<T> {
  parsed: T;
  rawText: string;
  usage: Anthropic.Message['usage'];
}

export class WorkerClient {
  constructor(
    private readonly client: Anthropic,
    private readonly budget: Budget,
    private readonly model = 'claude-haiku-4-5',
  ) {}

  async invoke<Schema extends z.ZodTypeAny>(
    inv: WorkerInvocation<Schema>,
  ): Promise<WorkerResult<z.infer<Schema>>> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: inv.maxTokens,
      // Workers do bounded structured analysis. Determinism > variety here —
      // they should produce the same JSON for the same input.
      temperature: 0,
      system: inv.systemPrompt,
      messages: [{ role: 'user', content: inv.userPrompt }],
    });

    this.budget.addUsage(this.model, response.usage);

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (textBlock === undefined) {
      throw new Error(`Worker '${inv.task}' returned no text block`);
    }

    const rawText = textBlock.text;
    const json = stripJsonFence(rawText);

    let unvalidated: unknown;
    try {
      unvalidated = JSON.parse(json);
    } catch (err) {
      await logger.warn(`Worker '${inv.task}' produced non-JSON output: ${rawText.slice(0, 200)}`);
      throw new Error(`Worker '${inv.task}' returned non-JSON: ${(err as Error).message}`);
    }

    const validation = inv.responseSchema.safeParse(unvalidated);
    if (!validation.success) {
      await logger.warn(
        `Worker '${inv.task}' returned JSON that failed schema validation: ${validation.error.message}`,
      );
      throw new Error(`Worker '${inv.task}' response failed schema: ${validation.error.message}`);
    }

    return {
      parsed: validation.data as z.infer<Schema>,
      rawText,
      usage: response.usage,
    };
  }
}

/**
 * Strips a leading ```json fence and trailing ``` from worker output. Haiku
 * sometimes wraps its JSON in a fenced block even when the prompt says
 * "return ONLY JSON" — being tolerant here avoids spurious parse failures.
 */
function stripJsonFence(text: string): string {
  let s = text.trim();
  if (s.startsWith('```json')) s = s.slice('```json'.length);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}
