/**
 * External architecture config (`.vor/architecture.yml`) and baseline
 * (`.vor/arch-baseline.json`) loaders.
 *
 * Failure contract: during PR review (`resolveEffectiveArchitectureConfig`),
 * missing/malformed external files warn and fall back rather than crashing the
 * review. Strict CLI commands (`vor config validate`, `vor arch check --arch-config`)
 * use the strict parser to surface schema/YAML errors loudly.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { loadConfigFromString, loadConfigStrict } from '../config/loader.js';
import { architectureExternalFileSchema } from '../config/schema.js';
import type {
  ArchitectureConfig,
  ArchitectureCustomRule,
  ArchitecturePresetId,
  ReviewConfig,
} from '../config/types.js';
import type { FileReader } from '../github/file-reader.js';
import { GitHubApiError, ConfigError } from '../util/errors.js';
import { logger } from '../util/logger.js';

export const DEFAULT_ARCH_FILE = '.vor/architecture.yml';
export const DEFAULT_BASELINE_FILE = '.vor/arch-baseline.json';

const baselineFileSchema = z.object({
  version: z.literal(1),
  fingerprints: z.array(z.string().min(1)),
});

/**
 * Confinement check preventing `../` traversal or absolute paths from reading
 * or writing files outside the workspace root.
 */
export function isSafeRelativePath(workspaceDir: string, relPath: string): boolean {
  if (!relPath || relPath.trim().length === 0 || isAbsolute(relPath)) return false;
  const root = resolve(workspaceDir);
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Validate custom rules have at least one target (`forbid_imports` or `forbid_packages`). */
export function validateArchitectureRules(rules: readonly ArchitectureCustomRule[]): string[] {
  const issues: string[] = [];
  for (const rule of rules) {
    const hasImports = rule.forbid_imports !== undefined && rule.forbid_imports.length > 0;
    const hasPackages = rule.forbid_packages !== undefined && rule.forbid_packages.length > 0;
    if (!hasImports && !hasPackages) {
      issues.push(
        `rule '${rule.id}' must specify at least one of forbid_imports or forbid_packages`,
      );
    }
  }
  return issues;
}

export function parseExternalArchitectureYamlStrict(yaml: string): Partial<ArchitectureConfig> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    throw new ConfigError(`Architecture YAML parse error: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('Architecture file must parse to a YAML mapping/object.');
  }

  const result = architectureExternalFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Architecture config validation failed: ${detail}`);
  }

  const data = result.data as Partial<ArchitectureConfig>;
  if (data.rules) {
    const ruleIssues = validateArchitectureRules(data.rules);
    if (ruleIssues.length > 0) {
      throw new ConfigError(`Architecture config validation failed: ${ruleIssues.join('; ')}`);
    }
  }
  return data;
}

export function parseExternalArchitectureYamlSafe(
  yaml: string,
  sourceLabel: string,
): Partial<ArchitectureConfig> | null {
  try {
    return parseExternalArchitectureYamlStrict(yaml);
  } catch (err) {
    void logger.warn(
      `Failed to load ${sourceLabel}: ${(err as Error).message}. Ignoring external architecture file.`,
    );
    return null;
  }
}

/**
 * Merge external architecture file values with inline `.vor.yml` config.
 * External values override defaulted inline settings (`severity`,
 * `llm_enforcement`, etc.) so setting `severity: critical` in `.vor/architecture.yml`
 * is not overwritten by `DEFAULT_CONFIG.architecture.severity`. Explicit
 * non-default inline settings (or explicit `rawInlineKeys`) win over external,
 * except `external.enabled === false` always disables enforcement.
 */
export function mergeArchitectureConfig(
  inline: ArchitectureConfig,
  external: Partial<ArchitectureConfig>,
  rawInline?: Partial<ArchitectureConfig>,
): ArchitectureConfig {
  const def = DEFAULT_CONFIG.architecture;
  const pickScalar = <
    K extends 'severity' | 'llm_enforcement' | 'deterministic_enforcement' | 'ignore_tests',
  >(
    key: K,
  ): ArchitectureConfig[K] => {
    if (rawInline && key in rawInline && rawInline[key] !== undefined) {
      return inline[key];
    }
    if (external[key] !== undefined && inline[key] === def[key]) {
      return external[key] as ArchitectureConfig[K];
    }
    return inline[key];
  };

  let mergedLayers: ArchitectureConfig['layers'] | undefined;
  if (external.layers || inline.layers) {
    mergedLayers = {};
    const names = new Set([
      ...Object.keys(external.layers ?? {}),
      ...Object.keys(inline.layers ?? {}),
    ]);
    for (const name of names) {
      mergedLayers[name] = {
        ...(external.layers?.[name] ?? {}),
        ...(inline.layers?.[name] ?? {}),
      };
    }
  }

  const enabled = external.enabled === false ? false : inline.enabled;

  return {
    enabled,
    ...(inline.file !== undefined ? { file: inline.file } : {}),
    ...(inline.preset !== undefined
      ? { preset: inline.preset }
      : external.preset !== undefined
        ? { preset: external.preset }
        : {}),
    ...(inline.root !== undefined
      ? { root: inline.root }
      : external.root !== undefined
        ? { root: external.root }
        : {}),
    severity: pickScalar('severity'),
    ...(mergedLayers !== undefined ? { layers: mergedLayers } : {}),
    ...(inline.contexts !== undefined
      ? { contexts: inline.contexts }
      : external.contexts !== undefined
        ? { contexts: external.contexts }
        : {}),
    ...(inline.rules !== undefined
      ? { rules: inline.rules }
      : external.rules !== undefined
        ? { rules: external.rules }
        : {}),
    ...(inline.principles !== undefined
      ? { principles: inline.principles }
      : external.principles !== undefined
        ? { principles: external.principles }
        : {}),
    ...(inline.include_preset_principles !== undefined
      ? { include_preset_principles: inline.include_preset_principles }
      : external.include_preset_principles !== undefined
        ? { include_preset_principles: external.include_preset_principles }
        : {}),
    llm_enforcement: pickScalar('llm_enforcement'),
    deterministic_enforcement: pickScalar('deterministic_enforcement'),
    ...(inline.exclude !== undefined
      ? { exclude: inline.exclude }
      : external.exclude !== undefined
        ? { exclude: external.exclude }
        : {}),
    ignore_tests: pickScalar('ignore_tests'),
    ...(inline.baseline_file !== undefined
      ? { baseline_file: inline.baseline_file }
      : external.baseline_file !== undefined
        ? { baseline_file: external.baseline_file }
        : {}),
  };
}

export interface ResolveExternalArchOpts {
  fileReader?: FileReader;
  owner?: string;
  repo?: string;
  ref?: string;
  workspaceDir?: string;
  rawInline?: Partial<ArchitectureConfig>;
}

/**
 * Resolve the effective {@link ArchitectureConfig} by optionally loading and
 * merging `config.file` (e.g. `.vor/architecture.yml`). Returns `config`
 * untouched with zero I/O when disabled or when `config.file` is unset.
 */
export async function resolveEffectiveArchitectureConfig(
  config: ArchitectureConfig,
  opts: ResolveExternalArchOpts = {},
): Promise<ArchitectureConfig> {
  if (!config.enabled || !config.file) {
    return config;
  }

  const baseDir = opts.workspaceDir ?? process.cwd();
  if (!isSafeRelativePath(baseDir, config.file)) {
    void logger.warn(
      `Architecture file path '${config.file}' escapes workspace root. Using inline config.`,
    );
    return config;
  }

  let raw: string | null = null;
  if (opts.fileReader && opts.owner && opts.repo && opts.ref) {
    try {
      raw = await opts.fileReader.read({
        owner: opts.owner,
        repo: opts.repo,
        path: config.file,
        ref: opts.ref,
      });
    } catch (err) {
      const status =
        err instanceof GitHubApiError && err.status != null ? ` (status ${err.status})` : '';
      void logger.debug(
        `Could not read ${config.file}@${opts.ref}${status}: ${(err as Error).message}`,
      );
    }
  }

  if (raw == null && opts.workspaceDir) {
    try {
      raw = readFileSync(resolve(opts.workspaceDir, config.file), 'utf-8');
    } catch {
      // File may genuinely not exist on disk in API-only reviews; handled below.
    }
  }

  if (raw == null || raw.trim().length === 0) {
    void logger.warn(
      `Configured architecture file '${config.file}' was not found or is empty. Using inline config.`,
    );
    return config;
  }

  const parsed = parseExternalArchitectureYamlSafe(raw, config.file);
  if (!parsed) return config;

  return mergeArchitectureConfig(config, parsed, opts.rawInline);
}

/**
 * Load baseline fingerprints from disk. Returns an empty set when absent or
 * malformed so baseline lookup never crashes a check.
 */
export function loadArchBaseline(workspaceDir: string, baselinePath: string): Set<string> {
  if (!isSafeRelativePath(workspaceDir, baselinePath)) {
    void logger.warn(`Baseline path '${baselinePath}' escapes workspace root. Ignoring baseline.`);
    return new Set();
  }
  const fullPath = resolve(workspaceDir, baselinePath);
  let raw: string;
  try {
    raw = readFileSync(fullPath, 'utf-8');
  } catch {
    return new Set(); // missing baseline means zero suppressed violations
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const result = baselineFileSchema.safeParse(parsed);
    if (!result.success) {
      void logger.warn(`Baseline file '${baselinePath}' has invalid schema. Ignoring baseline.`);
      return new Set();
    }
    return new Set(result.data.fingerprints);
  } catch (err) {
    void logger.warn(
      `Failed to parse baseline file '${baselinePath}': ${(err as Error).message}. Ignoring baseline.`,
    );
    return new Set();
  }
}

export function saveArchBaseline(
  workspaceDir: string,
  baselinePath: string,
  fingerprints: readonly string[],
): string {
  if (!isSafeRelativePath(workspaceDir, baselinePath)) {
    throw new ConfigError(`Baseline path '${baselinePath}' must stay inside the workspace.`);
  }
  const fullPath = resolve(workspaceDir, baselinePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const uniqueSorted = [...new Set(fingerprints)].sort();
  const payload = { version: 1 as const, fingerprints: uniqueSorted };
  writeFileSync(fullPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  return fullPath;
}

export interface ResolveWorkspaceArchOptions {
  workspaceDir: string;
  configPath?: string;
  archConfigPath?: string;
  preset?: ArchitecturePresetId;
  root?: string;
  strict?: boolean;
}

export interface ResolvedWorkspaceArch {
  reviewConfig: ReviewConfig;
  architecture: ArchitectureConfig;
}

/**
 * Resolve architecture configuration for local CLI/MCP commands:
 *   1. `.vor.yml` (if present and confined inside `workspaceDir`)
 *   2. Explicit `archConfigPath`, else `architecture.file`, else `.vor/architecture.yml`
 *      auto-discovery when `.vor.yml` hasn't enabled architecture
 *   3. Optional ad-hoc `preset` / `root` overrides
 */
export function resolveWorkspaceArchitectureConfig(
  opts: ResolveWorkspaceArchOptions,
): ResolvedWorkspaceArch {
  const configRel = opts.configPath ?? '.vor.yml';
  if (!isSafeRelativePath(opts.workspaceDir, configRel)) {
    throw new ConfigError(`Config path '${configRel}' escapes workspace root.`);
  }

  let rawVorYml: string | null = null;
  try {
    rawVorYml = readFileSync(resolve(opts.workspaceDir, configRel), 'utf-8');
  } catch {
    rawVorYml = null; // missing .vor.yml falls back to defaults
  }

  const reviewConfig =
    rawVorYml === null
      ? DEFAULT_CONFIG
      : opts.strict
        ? loadConfigStrict(rawVorYml)
        : loadConfigFromString(rawVorYml);

  if (opts.strict && reviewConfig.architecture.rules) {
    const issues = validateArchitectureRules(reviewConfig.architecture.rules);
    if (issues.length > 0) {
      throw new ConfigError(`Architecture config validation failed: ${issues.join('; ')}`);
    }
  }

  let arch = reviewConfig.architecture;
  const explicitFile = opts.archConfigPath ?? arch.file;

  if (explicitFile) {
    if (!isSafeRelativePath(opts.workspaceDir, explicitFile)) {
      throw new ConfigError(`Architecture config path '${explicitFile}' escapes workspace root.`);
    }
    let extRaw: string;
    try {
      extRaw = readFileSync(resolve(opts.workspaceDir, explicitFile), 'utf-8');
    } catch (err) {
      throw new ConfigError(
        `Architecture config file '${explicitFile}' could not be read: ${(err as Error).message}`,
        { cause: err },
      );
    }
    const extParsed = parseExternalArchitectureYamlStrict(extRaw);
    const baseArch = opts.archConfigPath ? { ...arch, enabled: extParsed.enabled !== false } : arch;
    arch = mergeArchitectureConfig(baseArch, extParsed);
  } else if (!arch.enabled && isSafeRelativePath(opts.workspaceDir, DEFAULT_ARCH_FILE)) {
    let defaultRaw: string | null = null;
    try {
      defaultRaw = readFileSync(resolve(opts.workspaceDir, DEFAULT_ARCH_FILE), 'utf-8');
    } catch {
      defaultRaw = null; // optional default .vor/architecture.yml absent
    }
    if (defaultRaw !== null && defaultRaw.trim().length > 0) {
      const extParsed = parseExternalArchitectureYamlStrict(defaultRaw);
      arch = mergeArchitectureConfig({ ...arch, enabled: extParsed.enabled !== false }, extParsed);
    }
  }

  if (opts.preset !== undefined || opts.root !== undefined) {
    arch = {
      ...arch,
      ...(opts.preset !== undefined ? { preset: opts.preset, enabled: true } : {}),
      ...(opts.root !== undefined ? { root: opts.root } : {}),
    };
  }

  return { reviewConfig, architecture: arch };
}
