import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config/defaults.js';

interface ActionInput {
  description: string;
  required?: boolean;
  default?: string;
}

const action = parseYaml(
  readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf-8'),
) as { inputs: Record<string, ActionInput> };

describe('action.yml inputs', () => {
  // `src/index.ts` treats a non-empty INPUT_MODEL / INPUT_MAX_TURNS as an
  // explicit override that beats `.vor.yml`. A `default:` here makes the input
  // non-empty on every run, so the consumer's config file can never win.
  it.each(['model', 'max_turns'])('%s has no default, so .vor.yml can set it', (name) => {
    expect(action.inputs[name]).toBeDefined();
    expect(action.inputs[name]!.default).toBeUndefined();
  });

  it('documents the built-in fallbacks that apply when neither source sets a value', () => {
    expect(action.inputs.model!.description).toContain(DEFAULT_CONFIG.model);
    expect(action.inputs.max_turns!.description).toContain(String(DEFAULT_CONFIG.max_turns));
  });
});
