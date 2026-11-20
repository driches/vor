import { z } from 'zod';

const severitySchema = z.enum(['critical', 'important', 'minor', 'nit']);
const eventSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const providerSchema = z.enum(['anthropic', 'openai']);
const openaiReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const unsafeOpenAIReasoningEffortOverrideSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'must be a 1-64 character provider value containing only letters, numbers, dot, underscore, or hyphen',
  )
  .refine((value) => value !== 'pro' && value !== 'standard', {
    message: 'cannot use an OpenAI reasoning mode as a reasoning effort',
  });

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
    image_ocr: scannerCommon.extend({
      max_image_bytes: z.number().int().positive().optional(),
      languages: z.array(z.string().min(1)).optional(),
    }),
  }),
  cache: z.object({ enabled: z.boolean() }),
  persistence: z.object({ enabled: z.boolean() }),
});

/**
 * Visual understanding of images via a cost-effective vision model. Off by
 * default — adds per-image token cost. When `model` is omitted the orchestrator
 * picks a cheap default for the resolved provider (Anthropic → claude-haiku-4-5).
 */
const imageUnderstandingSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).optional(),
  max_images: z.number().int().positive().optional(),
});

const experimentalSchema = z.object({
  worker_delegation: z.object({
    enabled: z.boolean(),
    worker_model: z.string().min(1),
  }),
  scanner_findings_in_user_prompt: z.boolean(),
});

const openaiProviderConfigSchema = z
  .object({
    service_tier: z.enum(['auto', 'default', 'flex']).optional(),
    prompt_cache_key: z.string().min(1).max(256).optional(),
    prompt_cache_retention: z.enum(['in_memory', '24h']).optional(),
    reasoning_effort: openaiReasoningEffortSchema.optional(),
    unsafe_reasoning_effort_override: unsafeOpenAIReasoningEffortOverrideSchema.optional(),
    text_verbosity: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.reasoning_effort !== undefined &&
      config.unsafe_reasoning_effort_override !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['unsafe_reasoning_effort_override'],
        message: 'cannot be combined with reasoning_effort',
      });
    }
  });

const providerConfigSchema = z
  .object({
    openai: openaiProviderConfigSchema,
  })
  .strict();

export const architecturePresetSchema = z.enum([
  'hexagonal',
  'ddd',
  'clean',
  'layered',
  'modular-monolith',
  'custom',
]);

export const architectureLayerOverrideSchema = z
  .object({
    paths: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
    can_import: z.array(z.string().min(1)).optional(),
    cannot_import: z.array(z.string().min(1)).optional(),
    forbid_packages: z.array(z.string().min(1)).optional(),
    allow_packages: z.array(z.string().min(1)).optional(),
    severity: severitySchema.optional(),
  })
  .strict();

export const architectureContextsSchema = z
  .object({
    pattern: z.string().min(1),
    public_api: z.array(z.string().min(1)).optional(),
    shared: z.array(z.string().min(1)).optional(),
    allow_public_api_imports: z.boolean().optional(),
    allow_dependencies: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
    severity: severitySchema.optional(),
  })
  .strict();

export const architectureCustomRuleSchema = z
  .object({
    id: z.string().min(1),
    from: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    forbid_imports: z.array(z.string().min(1)).optional(),
    forbid_packages: z.array(z.string().min(1)).optional(),
    severity: severitySchema.optional(),
    reason: z.string().min(1),
  })
  .strict();

export const architectureSchema = z
  .object({
    enabled: z.boolean(),
    file: z.string().min(1).optional(),
    preset: architecturePresetSchema.optional(),
    root: z.string().min(1).optional(),
    severity: severitySchema,
    layers: z.record(z.string().min(1), architectureLayerOverrideSchema).optional(),
    contexts: architectureContextsSchema.optional(),
    rules: z.array(architectureCustomRuleSchema).optional(),
    principles: z.array(z.string().min(1)).optional(),
    include_preset_principles: z.boolean().optional(),
    llm_enforcement: z.boolean(),
    deterministic_enforcement: z.boolean(),
    exclude: z.array(z.string().min(1)).optional(),
    ignore_tests: z.boolean(),
    baseline_file: z.string().min(1).optional(),
  })
  .strict();

/**
 * Schema for standalone `.vor/architecture.yml` files. Every field is optional;
 * `file` is omitted because external files shouldn't chain indefinitely.
 */
export const architectureExternalFileSchema = architectureSchema
  .omit({ file: true })
  .partial()
  .strict();

export const referenceModeSchema = z.enum(['auto', 'inline', 'on_demand']);

export const referenceSourceObjectSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    url: z.string().url().optional(),
    github: z.string().min(1).optional(),
    mode: referenceModeSchema.optional(),
    ttl_seconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export const referenceSourceSchema = z.union([z.string().min(1), referenceSourceObjectSchema]);

export const referencesSchema = z
  .object({
    enabled: z.boolean(),
    sources: z.array(referenceSourceSchema),
    max_inline_bytes: z.number().int().positive().max(2_000_000),
    max_doc_bytes: z.number().int().positive().max(1_000_000),
    max_docs: z.number().int().positive().max(500),
    cache: z
      .object({
        enabled: z.boolean(),
        dir: z.string().min(1).optional(),
        ttl_seconds: z.number().int().nonnegative(),
        stale_on_error: z.boolean(),
      })
      .strict(),
    prompt_cache: z
      .object({
        enabled: z.boolean(),
        anthropic_ttl: z.enum(['5m', '1h']),
        auto_openai_cache_key: z.boolean(),
      })
      .strict(),
  })
  .strict();

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

    image_understanding: imageUnderstandingSchema,

    architecture: architectureSchema,

    references: referencesSchema,

    experimental: experimentalSchema,
  })
  .strict();

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Zod 4 removed `ZodObject.deepPartial()`, and `.partial()` throws on an
 * object that carries refinements, so the partial schema is rebuilt here.
 * Each object is recreated with every key optional, keeping what the
 * original enforced: strictness (a `never` catchall) and refinement checks.
 * Arrays and records are left alone — the loader replaces them wholesale, and
 * array/record entries (`architecture.rules`, `references.sources`,
 * `architecture.layers`) keep their full element schemas.
 */
function deepPartial(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) return deepPartial(schema.unwrap() as z.ZodType);
  if (!(schema instanceof z.ZodObject)) return schema;

  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = deepPartial(field as z.ZodType).optional();
  }
  const isStrict = schema.def.catchall instanceof z.ZodNever;
  const rebuilt = isStrict ? z.strictObject(shape) : z.object(shape);
  // Zod types a stored check against `never`, so it cannot be handed back to
  // `.check()` without widening. A refinement written for the full object now
  // sees every key as possibly undefined; the only refined object today
  // (`providers.openai`) was already all-optional, so its check is unaffected.
  const checks = (schema.def.checks ?? []) as z.core.$ZodCheck<Record<string, unknown>>[];
  return checks.length > 0 ? rebuilt.check(...checks) : rebuilt;
}

export type PartialConfig = DeepPartial<z.infer<typeof configSchema>>;

/**
 * Partial schema for user-supplied YAML. `deepPartial` walks the schema at
 * runtime, so its static return type is the erased `z.ZodType`; the assertion
 * restores the output type that walk produces.
 */
export const partialConfigSchema = deepPartial(configSchema) as z.ZodType<PartialConfig>;
