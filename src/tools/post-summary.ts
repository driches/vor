/**
 * TERMINATES the agent run. Validates the assessment is consistent with what
 * was posted (e.g., request_changes requires at least one critical/important).
 */
import { tool } from './tool-helper.js';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';

export function makePostSummaryTool(deps: ToolDeps) {
  return tool(
    'post_summary',
    'Posts the PR-level summary and ENDS the review. Call this exactly once, ' +
      'last. Requires 1-5 specific strengths (something the author did well) and ' +
      'an assessment with reasoning.\n\n' +
      'assessment values:\n' +
      '- approve: no significant issues; ready to merge\n' +
      '- comment: observations only; not blocking\n' +
      '- request_changes: at least one critical or important finding (validated)',
    {
      strengths: z
        .array(z.string().min(10).max(280))
        .min(1)
        .max(5)
        .describe('1-5 specific strengths. "Nice PR" is not specific. Cite what.'),
      assessment: z.enum(['approve', 'request_changes', 'comment']),
      assessment_reasoning: z
        .string()
        .min(30)
        .max(800)
        .describe('Why this assessment, in 1-3 sentences. Be concrete.'),
      coverage_note: z
        .string()
        .max(400)
        .optional()
        .describe('Optional note about coverage gaps, e.g., "Skipped generated proto files."'),
      unreviewed_paths: z
        .array(z.string())
        .optional()
        .describe('Paths intentionally not reviewed (e.g., out of token budget).'),
    },
    async (args) => {
      if (deps.aggregator.hasSummary()) {
        return jsonResult({
          accepted: false,
          reason: 'post_summary may only be called once',
          hint: 'You already posted a summary. The review will end after this call.',
        });
      }

      if (args.assessment === 'request_changes' && !deps.aggregator.hasCriticalOrImportant()) {
        return jsonResult({
          accepted: false,
          reason:
            "assessment 'request_changes' requires at least one critical or important inline comment",
          hint: 'Either downgrade to "comment", or post a critical/important finding first.',
        });
      }

      deps.aggregator.setSummary({
        strengths: args.strengths,
        assessment: args.assessment,
        assessment_reasoning: args.assessment_reasoning,
        ...(args.coverage_note !== undefined ? { coverage_note: args.coverage_note } : {}),
        ...(args.unreviewed_paths !== undefined ? { unreviewed_paths: args.unreviewed_paths } : {}),
      });

      return jsonResult({
        accepted: true,
        comments_posted: deps.aggregator.acceptedComments.length,
        assessment: args.assessment,
        message: 'Review complete. The runner will now post your review to GitHub.',
      });
    },
  );
}
