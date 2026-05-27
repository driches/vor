/**
 * THE main output tool — the only way for the agent to surface a finding.
 *
 * Every call runs through the validator (the choke point). On rejection,
 * returns a structured hint so the agent can self-correct.
 */
import { tool } from './tool-helper.js';
import { z } from 'zod';
import { validateInlineComment } from '../agent/validate-comment.js';
import {
  CATEGORIES,
  type Category,
  type Confidence,
  type Severity,
  type Side,
} from '../types.js';
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
      const normalizedSuggestion =
        typeof args.suggestion === 'string'
          ? normalizeSuggestion(args.suggestion)
          : undefined;
      // Schema-level invariant: suggestion required for high severity
      if (
        (args.severity === 'critical' || args.severity === 'important') &&
        !normalizedSuggestion
      ) {
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

      // The Zod schema above declares `side: ...default('RIGHT')` and
      // `confidence: ...default('high')`, but the agent runner forwards raw
      // tool input directly to this handler without running it through Zod,
      // so those defaults never fire at runtime. Normalize here against an
      // explicit allowlist rather than `??` alone so that an unexpected
      // string (e.g. the agent sends 'left' lowercase) falls back to the
      // safe default instead of being cast through to a malformed value.
      //
      // The `side` default in particular is load-bearing: the post-filter
      // scanner-vs-AI dedup (src/scanners/dedup.ts) requires `ai.side ===
      // c.side` to consider an overlap, and the scanner adapter hard-codes
      // `side: 'RIGHT'`. If the agent omits `side` (which it usually does
      // — RIGHT is the only sensible value for almost every comment) the
      // AI's PostedComment lands in the aggregator with `side: undefined`,
      // the dedup check fails on the side mismatch, and the scanner finding
      // ships next to the AI's security comment as a duplicate. PR #12 and
      // PR #16 smoke tests both reproduced this.
      //
      // TODO (follow-up): fix the runner to parse tool input through Zod
      // before dispatching (src/agent/runner.ts ~line 194). That would
      // also fix the same Zod-bypass bug class in grep-repo-at-ref
      // (`case_sensitive` defaults silently flip to `-i` on every agent
      // grep), get-pr-diff (`max_diff_lines`), and read-file-at-ref
      // (`ref` falls back to base instead of head).
      const rawSide = args.side;
      const side: Side = rawSide === 'RIGHT' || rawSide === 'LEFT' ? rawSide : 'RIGHT';
      const rawConfidence = args.confidence;
      const confidence: Confidence =
        rawConfidence === 'high' || rawConfidence === 'medium' || rawConfidence === 'low'
          ? rawConfidence
          : 'high';

      // Map raw schema input → validator input + PostedComment shape
      const changedFiles = new Map(deps.prContext.files.map((f) => [f.path, f]));
      const validation = validateInlineComment(
        {
          severity: args.severity as Severity,
          file_path: args.file_path,
          line: args.line,
          ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
          side,
          category: args.category as Category,
          title: args.title,
          why_it_matters: args.why_it_matters,
          ...(normalizedSuggestion !== undefined ? { suggestion: normalizedSuggestion } : {}),
          confidence,
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
        side,
        category: args.category as Category,
        title: args.title,
        why_it_matters: args.why_it_matters,
        ...(normalizedSuggestion !== undefined ? { suggestion: normalizedSuggestion } : {}),
        confidence,
      });
      return jsonResult({
        accepted: true,
        comment_id: id,
        comments_so_far: deps.aggregator.acceptedComments.length,
      });
    },
  );
}

/**
 * Models sometimes include a full Markdown fence in the `suggestion` field even
 * though the review renderer wraps that field in its own ```suggestion block.
 * Strip one outer fence so GitHub receives a valid one-click suggestion rather
 * than nested fences rendered as literal text.
 */
export function normalizeSuggestion(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:suggestion|[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```$/);
  return (fenced?.[1] ?? raw).replace(/\s+$/g, '');
}
