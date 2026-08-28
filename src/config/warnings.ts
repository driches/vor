/**
 * Keep the unsafe-override warning identical across local config inspection
 * and real review runs so an operator sees the same risk at both boundaries.
 */
export function unsafeReasoningEffortWarning(model: string, value: string): string {
  return (
    `providers.openai.unsafe_reasoning_effort_override="${value}" bypasses Vor's ` +
    `supported reasoning-effort catalog for model "${model}". The provider may reject it, ` +
    'and Vor cannot validate provider/model compatibility or cost impact.'
  );
}
