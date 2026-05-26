/**
 * Smoke test: exercise OpenAIProvider end-to-end against the real Responses API.
 *
 *   OPENAI_API_KEY=sk-... npx tsx scripts/smoke-openai.ts
 *
 * Runs a 2-turn conversation: ask for the weather, model calls a `get_weather`
 * tool, we feed back a result, model produces final text. Verifies every
 * canonical surface the action depends on:
 *   - request body shape accepted by the Responses API (flat function tools,
 *     `instructions`, `store:false`, no `temperature` for o-series, etc.)
 *   - response parsing produces canonical `text` + `tool_calls` + `stop_reason`
 *   - usage maps correctly (input/output/cache_read tokens)
 *   - provider_state round-trips so multi-turn replay works
 *   - pricing computes a non-NaN cost number
 *
 * Uses `gpt-4o-mini` — cheapest model; this exchange costs <$0.001.
 */
import { OpenAIProvider } from '../src/llm/openai-provider.js';
import type { CanonicalMessage, CanonicalTool } from '../src/llm/types.js';
import { costFromUsage, pricingForModel } from '../src/util/pricing.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const MODEL = 'gpt-4o-mini';

async function main(): Promise<void> {
  console.log(`\n=== Smoke test: OpenAIProvider against ${MODEL} ===\n`);

  const provider = new OpenAIProvider(apiKey!);
  console.log(`provider.id = ${provider.id}`);
  console.log(`pricing for ${MODEL}:`, pricingForModel(MODEL));

  const tools: CanonicalTool[] = [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
    },
  ];

  const messages: CanonicalMessage[] = [
    { role: 'user', content: "What's the weather in Tokyo right now? Use the tool." },
  ];

  // ============================================================
  // Turn 1: expect a tool_call
  // ============================================================
  console.log('\n--- Turn 1: send user message, expect tool_call ---');
  const r1 = await provider.complete(messages, tools, {
    model: MODEL,
    maxOutputTokens: 512,
    system: 'You are a helpful weather assistant. Always use the provided tool — never make up weather data.',
    temperature: 0.3,
  });

  console.log('text:        ', JSON.stringify(r1.text));
  console.log('tool_calls:  ', JSON.stringify(r1.tool_calls, null, 2));
  console.log('stop_reason: ', r1.stop_reason);
  console.log('usage:       ', JSON.stringify(r1.usage));
  console.log('provider_state present:', r1.provider_state !== undefined);
  console.log('billable input tokens (budget):', provider.inputTokensFullRate(r1.usage));

  if (r1.tool_calls.length === 0) {
    console.error('\nFAIL: expected a tool_call on turn 1 but got none');
    process.exit(1);
  }
  if (r1.stop_reason !== 'tool_calls') {
    console.error(`\nFAIL: expected stop_reason="tool_calls" on turn 1 but got "${r1.stop_reason}"`);
    process.exit(1);
  }

  const toolCall = r1.tool_calls[0]!;
  if (toolCall.name !== 'get_weather') {
    console.error(`\nFAIL: expected tool name "get_weather" but got "${toolCall.name}"`);
    process.exit(1);
  }
  console.log(`✓ tool_call.arguments parsed:`, toolCall.arguments);

  // ============================================================
  // Turn 2: feed back the tool result, expect final text
  // ============================================================
  console.log('\n--- Turn 2: send tool result, expect final text ---');
  messages.push({
    role: 'assistant',
    text: r1.text,
    tool_calls: r1.tool_calls,
    provider_state: r1.provider_state,
  });
  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify({ city: toolCall.arguments['city'], condition: 'Sunny', temperature_c: 22 }),
  });

  const r2 = await provider.complete(messages, tools, {
    model: MODEL,
    maxOutputTokens: 256,
    system: 'You are a helpful weather assistant. Always use the provided tool — never make up weather data.',
    temperature: 0.3,
  });

  console.log('text:        ', JSON.stringify(r2.text));
  console.log('tool_calls:  ', r2.tool_calls.length);
  console.log('stop_reason: ', r2.stop_reason);
  console.log('usage:       ', JSON.stringify(r2.usage));

  if (r2.stop_reason !== 'end_turn') {
    console.error(`\nFAIL: expected stop_reason="end_turn" on turn 2 but got "${r2.stop_reason}"`);
    process.exit(1);
  }
  if (r2.text.length === 0) {
    console.error('\nFAIL: expected text on turn 2 but got empty string');
    process.exit(1);
  }

  // ============================================================
  // Cost computation
  // ============================================================
  console.log('\n--- Cost summary ---');
  const c1 = costFromUsage(MODEL, {
    inputTokens: r1.usage.input_tokens,
    outputTokens: r1.usage.output_tokens,
    cacheReadTokens: r1.usage.cache_read_tokens,
  });
  const c2 = costFromUsage(MODEL, {
    inputTokens: r2.usage.input_tokens,
    outputTokens: r2.usage.output_tokens,
    cacheReadTokens: r2.usage.cache_read_tokens,
  });
  console.log(`turn 1 cost: $${c1.toFixed(6)}`);
  console.log(`turn 2 cost: $${c2.toFixed(6)}`);
  console.log(`total:       $${(c1 + c2).toFixed(6)}`);

  if (!Number.isFinite(c1 + c2) || c1 + c2 === 0) {
    console.error(`\nFAIL: cost computed as ${c1 + c2} (expected positive finite number)`);
    process.exit(1);
  }

  console.log('\n=== SMOKE TEST PASSED ===\n');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
