import { z } from 'zod';

const severitySchema = z.enum(['critical', 'important', 'minor', 'nit']);
const eventSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const providerSchema = z.enum(['anthropic', 'openai']);
const openaiReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const scannerCommon = z.object({
  enabled: z.boolean(),
  min_severity: severitySchema.optional(),
});

const semgrepSchema = z.object({
  // Path is a free-form string (relative to workspaceDir OR absolute) that
  // we existence-check at run time; treating it as a path-segment regex
  // here would reject perfectly valid absolute paths on Windows.
  //
  // The empty string is allowed and acts as an explicit opt-out: it
  // bypasses the default `.vor/semgrep-rules` directory without
  // forcing the operator to also disable the entire sast scanner. The
  // resolver in semgrep.ts treats unset, empty, and missing-on-disk
  // identically — all three forward only `--config=auto`.
  custom_rules_path: z.string().optional(),
});

const sastSchema = scannerCommon.extend({
  semgrep: semgrepSchema.optional(),
  // tsc gets an explicit per-linter opt-out (the rest of the SAST linters
  // quietly no-op when their binary isn't installed; tsc's binary is
  // present in most npm-install'd workspaces, so operators may legitimately
  // want it OFF without disabling all of sast).
  tsc: z.object({ enabled: z.boolean().optional() }).optional(),
});

const securitySchema = z.object({
  enabled: z.boolean(),
  ignore_file: z.string(),
  scanners: z.object({
    dependency_cve: scannerCommon.extend({ osv_endpoint: z.string().url().optional() }),
    secrets: scannerCommon.extend({ include_generic_entropy: z.boolean() }),
    sast: sastSchema,
    container_cve: scannerCommon,
    coverage_delta: scannerCommon,
    debris: scannerCommon,
    migration_safety: scannerCommon,
    dependency_hygiene: scannerCommon,
  }),
  cache: z.object({ enabled: z.boolean() }),
  persistence: z.object({ enabled: z.boolean() }),
});

const experimentalSchema = z.object({
  worker_delegation: z.object({
    enabled: z.boolean(),
    worker_model: z.string().min(1),
  }),
  scanner_findings_in_user_prompt: z.boolean(),
});

const providerConfigSchema = z.object({
  openai: z.object({
    service_tier: z.enum(['auto', 'default', 'flex']).optional(),
    prompt_cache_key: z.string().min(1).max(256).optional(),
    prompt_cache_retention: z.enum(['in_memory', '24h']).optional(),
    reasoning_effort: openaiReasoningEffortSchema.optional(),
    text_verbosity: z.enum(['low', 'medium', 'high']).optional(),
  }),
});

/**
 * Zod schema for `.vor.yml`. All fields optional; missing values are
 * merged from DEFAULT_CONFIG by the loader.
 */
export const configSchema = z
  .object({
    model: z.string().min(1),
    provider: providerSchema.optional(),
    max_turns: z.number().int().positive().max(200),

    exclude: z.object({
      paths: z.array(z.string()),
      max_diff_lines_per_file: z.number().int().positive(),
    }),

    focus: z.object({
      security: z.boolean(),
      performance: z.boolean(),
      correctness: z.boolean(),
      style: z.boolean(),
      tests: z.boolean(),
      docs: z.boolean(),
    }),

    severity: z.object({
      floor: severitySchema,
      max_comments_per_file: z.number().int().positive().max(50),
      max_comments_total: z.number().int().positive().max(200),
    }),

    context: z.object({
      include: z.array(z.string()),
      max_context_bytes: z.number().int().positive().max(500_000),
      blast_radius: z.object({
        enabled: z.boolean(),
        max_symbols: z.number().int().positive().max(200),
        max_refs_per_symbol: z.number().int().positive().max(50),
      }),
    }),

    prompt: z.object({
      additions: z.string(),
    }),

    review: z.object({
      event: eventSchema,
      sticky: z.boolean(),
      post_summary: z.boolean(),
    }),

    budget: z.object({
      max_input_tokens: z.number().int().positive(),
      max_output_tokens: z.number().int().positive(),
    }),

    security: securitySchema,

    providers: providerConfigSchema,

    experimental: experimentalSchema,
  })
  .strict();

/** Partial schema for user-supplied YAML. Deep-partial via deepPartial(). */
export const partialConfigSchema = configSchema.deepPartial();

export type PartialConfig = z.infer<typeof partialConfigSchema>;
