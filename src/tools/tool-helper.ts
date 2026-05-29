/**
 * Local replacement for `tool()` from `@anthropic-ai/claude-agent-sdk`.
 * We don't use the Agent SDK's query() loop (it has bugs around in-process
 * MCP servers); we just need a typed structure that pairs name/desc/schema
 * with a handler. The runner converts these to Anthropic API tool defs.
 *
 * Mirrors the SDK's InferShape so handlers get typed args from the Zod schema.
 *
 * The returned `handler` parses its raw input through `z.object(inputSchema)`
 * before delegating to the typed user handler. This is the single choke point
 * that makes schema-level `.default(...)` values and coercions actually fire
 * at runtime — the agent's tool call only carries the fields the model chose
 * to send, and the runner (and tests) invoke `handler` with that raw object.
 * Without this parse, an omitted field with a default arrived as `undefined`
 * (e.g. `read_file_at_ref`'s `ref` read BASE instead of HEAD; `grep_repo_at_ref`'s
 * `case_sensitive` flipped to `-i`). Invalid input throws a readable error,
 * which the agent runner surfaces to the model as an is_error tool result so
 * it can self-correct.
 */

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';

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
  /**
   * Accepts raw, unvalidated tool input (whatever the model or a test passes).
   * The wrapper parses it through `inputSchema` — applying Zod defaults and
   * coercions — before the typed user handler runs.
   */
  handler: (args: unknown, extra: unknown) => Promise<SdkToolResult>;
}

export function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: Inferred<Schema>, extra: unknown) => Promise<SdkToolResult>,
): SdkToolDefinition<Schema> {
  const schema = z.object(inputSchema);
  return {
    name,
    description,
    inputSchema,
    handler: async (rawArgs, extra) => {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid arguments for ${name}: ${detail}`);
      }
      // parsed.data is structurally identical to Inferred<Schema> (both derive
      // from the same shape); zod's inferred object type and our mapped type
      // aren't seen as assignable by the compiler, so assert across them.
      return handler(parsed.data as unknown as Inferred<Schema>, extra);
    },
  };
}
