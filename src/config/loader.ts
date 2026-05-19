import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { partialConfigSchema, type PartialConfig } from './schema.js';
import type { ReviewConfig } from './types.js';

/**
 * Deep merge: user values override defaults. Arrays are REPLACED, not concatenated.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base !== 'object' || typeof override !== 'object') return override as T;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = deepMerge(
      (base as Record<string, unknown>)[key] as unknown,
      value,
    );
  }
  return result as T;
}

/**
 * Parse YAML text and merge with defaults. On schema errors, log and return defaults.
 */
export function loadConfigFromString(yaml: string | null | undefined): ReviewConfig {
  if (!yaml || yaml.trim().length === 0) {
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    void logger.warn(`Failed to parse .code-review.yml: ${(err as Error).message}. Using defaults.`);
    return DEFAULT_CONFIG;
  }

  if (parsed == null || typeof parsed !== 'object') {
    return DEFAULT_CONFIG;
  }

  const result = partialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errMsg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    void logger.warn(`.code-review.yml validation failed: ${errMsg}. Using defaults.`);
    return DEFAULT_CONFIG;
  }

  return deepMerge(DEFAULT_CONFIG, result.data as PartialConfig);
}

/**
 * Reject invalid YAML hard (used internally for tests that want strict failure).
 */
export function loadConfigStrict(yaml: string): ReviewConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    throw new ConfigError(`YAML parse error: ${(err as Error).message}`, { cause: err });
  }

  const result = partialConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Config validation failed: ${result.error.message}`);
  }
  return deepMerge(DEFAULT_CONFIG, result.data as PartialConfig);
}
