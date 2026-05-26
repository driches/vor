import { z } from 'zod';

const severitySchema = z.enum(['critical', 'important', 'minor', 'nit']);
const eventSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const providerSchema = z.enum(['anthropic', 'openai']);

const scannerCommon = z.object({
  enabled: z.boolean(),
  min_severity: severitySchema.optional(),
});

const securitySchema = z.object({
  enabled: z.boolean(),
  ignore_file: z.string(),
  scanners: z.object({
    dependency_cve: scannerCommon.extend({ osv_endpoint: z.string().url().optional() }),
    secrets: scannerCommon.extend({ include_generic_entropy: z.boolean() }),
    sast: scannerCommon,
    container_cve: scannerCommon,
  }),
  cache: z.object({ enabled: z.boolean() }),
  persistence: z.object({ enabled: z.boolean() }),
});

const experimentalSchema = z.object({
  worker_delegation: z.object({
    enabled: z.boolean(),
    worker_model: z.string().min(1),
  }),
});

/**
 * Zod schema for `.code-review.yml`. All fields optional; missing values are
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

    experimental: experimentalSchema,
  })
  .strict();

/** Partial schema for user-supplied YAML. Deep-partial via deepPartial(). */
export const partialConfigSchema = configSchema.deepPartial();

export type PartialConfig = z.infer<typeof partialConfigSchema>;
