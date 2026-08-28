import { describe, expect, it } from 'vitest';
import { unsafeReasoningEffortWarning } from './warnings.js';

describe('unsafeReasoningEffortWarning', () => {
  it('names the model, override value, and unvalidated compatibility and cost', () => {
    expect(unsafeReasoningEffortWarning('gpt-future', 'future-1')).toBe(
      'providers.openai.unsafe_reasoning_effort_override="future-1" bypasses Vor\'s ' +
        'supported reasoning-effort catalog for model "gpt-future". The provider may reject it, ' +
        'and Vor cannot validate provider/model compatibility or cost impact.',
    );
  });
});
