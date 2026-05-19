import { z } from 'zod';

const severitySchema = z.enum(['critical', 'important', 'minor', 'nit']);
const eventSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

/**
 * Zod schema for `.code-review.yml`. All fields optional; missing values are
 * merged from DEFAULT_CONFIG by the loader.
 */
export const configSchema = z
  .object({
    model: z.string().min(1),
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
  })
  .strict();

/** Partial schema for user-supplied YAML. Deep-partial via deepPartial(). */
export const partialConfigSchema = configSchema.deepPartial();

export type PartialConfig = z.infer<typeof partialConfigSchema>;
