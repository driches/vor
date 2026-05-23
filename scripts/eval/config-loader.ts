/**
 * Load a pipeline config YAML file from disk and produce a fully-resolved
 * ReviewConfig (with all defaults filled in).
 *
 * Reuses the existing Zod schema + deepMerge from src/config so the schema
 * stays in lockstep with how production `.code-review.yml` files are loaded.
 *
 * Unlike `loadConfigFromString` (which silently falls back to defaults on
 * parse/schema errors so production reviews don't crash on a malformed user
 * YAML), this loader throws hard. The eval harness WANTS to fail loudly on
 * config bugs — silently using defaults would hide them in the test matrix.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { deepMerge } from '../../src/config/loader.js';
import { partialConfigSchema, type PartialConfig } from '../../src/config/schema.js';
import type { ReviewConfig } from '../../src/config/types.js';

export function loadPipelineConfig(path: string): ReviewConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read pipeline config ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Pipeline config ${path} failed to parse: ${(err as Error).message}`,
    );
  }

  // Empty file or scalar → just use defaults.
  if (parsed == null || typeof parsed !== 'object') {
    return DEFAULT_CONFIG;
  }

  const result = partialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Pipeline config ${path} is invalid: ${issues}`);
  }

  return deepMerge(DEFAULT_CONFIG, result.data as PartialConfig);
}
