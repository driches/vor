/**
 * Local replacement for `tool()` from `@anthropic-ai/claude-agent-sdk`.
 * We don't use the Agent SDK's query() loop (it has bugs around in-process
 * MCP servers); we just need a typed structure that pairs name/desc/schema
 * with a handler. The runner converts these to Anthropic API tool defs.
 *
 * Mirrors the SDK's InferShape so handlers get typed args from the Zod schema.
 */

import type { ZodRawShape, ZodTypeAny } from 'zod';

export interface SdkToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type Inferred<Shape extends ZodRawShape> = {
  [K in keyof Shape]: Shape[K] extends ZodTypeAny ? Shape[K]['_output'] : never;
};

export interface SdkToolDefinition<Schema extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: Inferred<Schema>, extra: unknown) => Promise<SdkToolResult>;
}

export function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: Inferred<Schema>, extra: unknown) => Promise<SdkToolResult>,
): SdkToolDefinition<Schema> {
  return { name, description, inputSchema, handler };
}
