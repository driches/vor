/**
 * THE main output tool — the only way for the agent to surface a finding.
 *
 * Every call runs through the validator (the choke point). On rejection,
 * returns a structured hint so the agent can self-correct.
 */
import { tool } from './tool-helper.js';
import { z } from 'zod';
import { validateInlineComment } from '../agent/validate-comment.js';
import { CATEGORIES, type Category, type Severity, type Side } from '../types.js';
import { jsonResult, type ToolDeps } from './types.js';

const severitySchema = z.enum(['critical', 'important', 'minor', 'nit']);
const categorySchema = z.enum(CATEGORIES);

export function makePostInlineCommentTool(deps: ToolDeps) {
  return tool(
    'post_inline_comment',
    'Posts an inline review comment on a specific line. THE ONLY way to surface ' +
      'a finding to the PR author. Prose written to stdout is ignored.\n\n' +
      'REQUIREMENTS:\n' +
      '- line MUST be in reviewable_lines for the file (see list_changed_files)\n' +
      '- For severity "critical" or "important", you MUST include a `suggestion` ' +
      'with the replacement code\n' +
      '- Body length cap: title + why_it_matters <= 600 chars\n' +
      '- One finding per call. Do not list multiple issues in why_it_matters.\n' +
      '- Returns { accepted: true, comment_id } on success, or ' +
      '{ accepted: false, reason, hint } so you can correct and retry.',
    {
      severity: severitySchema,
      file_path: z.string().describe('Path of the file in the PR.'),
      line: z.number().int().positive().describe('Line number in the HEAD file.'),
      start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('For multi-line comments, the first line. Must be < line.'),
      side: z
        .enum(['RIGHT', 'LEFT'])
        .default('RIGHT')
        .describe('RIGHT = new file (default; almost always what you want).'),
      category: categorySchema,
      title: z.string().min(8).max(120).describe('One-line headline of the issue.'),
      why_it_matters: z
        .string()
        .min(20)
        .max(500)
        .describe('1-3 sentences on why this matters: user impact, maintainability cost.'),
      suggestion: z
        .string()
        .optional()
        .describe(
          'Replacement code rendered as a ```suggestion block (one-click apply). ' +
            'REQUIRED for severity critical or important.',
        ),
      confidence: z
        .enum(['high', 'medium', 'low'])
        .default('high')
        .describe('Your confidence in the finding. Mark medium/low if you are unsure.'),
    },
    async (args) => {
      // Schema-level invariant: suggestion required for high severity
      if ((args.severity === 'critical' || args.severity === 'important') && !args.suggestion) {
        return jsonResult({
          accepted: false,
          reason: `severity '${args.severity}' requires a suggestion`,
          hint: 'Either include `suggestion` with replacement code, or lower the severity.',
        });
      }
      if (args.start_line !== undefined && args.start_line >= args.line) {
        return jsonResult({
          accepted: false,
          reason: `start_line (${args.start_line}) must be less than line (${args.line})`,
          hint: 'Swap them or omit start_line.',
        });
      }

      // Map raw schema input → validator input + PostedComment shape
      const changedFiles = new Map(deps.prContext.files.map((f) => [f.path, f]));
      const validation = validateInlineComment(
        {
          severity: args.severity as Severity,
          file_path: args.file_path,
          line: args.line,
          ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
          side: args.side as Side,
          category: args.category as Category,
          title: args.title,
          why_it_matters: args.why_it_matters,
          ...(args.suggestion !== undefined ? { suggestion: args.suggestion } : {}),
          confidence: args.confidence,
        },
        {
          changedFiles,
          postedComments: deps.aggregator.acceptedComments,
          severityFloor: deps.config.severity.floor,
          maxBodyChars: 600,
          // Read-before-post enforcement is opt-in: repos that enable worker
          // delegation also accept the verification discipline (Sonnet must
          // have read the target lines before posting critical/important).
          // Repos without workers keep the v0.2.x validator semantics, so
          // shipping v0.3.0 with the flag off is zero behavior change.
          ...(deps.config.experimental.worker_delegation.enabled
            ? { runContext: deps.runContext }
            : {}),
        },
      );

      if (!validation.ok) {
        return jsonResult({
          accepted: false,
          reason: validation.reason,
          hint: validation.hint,
        });
      }

      const id = `c_${deps.aggregator.acceptedComments.length + 1}`;
      deps.aggregator.addComment({
        severity: args.severity as Severity,
        file_path: args.file_path,
        line: args.line,
        ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
        side: args.side as Side,
        category: args.category as Category,
        title: args.title,
        why_it_matters: args.why_it_matters,
        ...(args.suggestion !== undefined ? { suggestion: args.suggestion } : {}),
        confidence: args.confidence,
      });
      return jsonResult({
        accepted: true,
        comment_id: id,
        comments_so_far: deps.aggregator.acceptedComments.length,
      });
    },
  );
}
