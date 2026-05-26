/**
 * worker_summarize_file — Sonnet delegates a "what does this file do" read
 * to a cheap Haiku worker.
 *
 * Sonnet's biggest non-verification cost driver is reading whole files for
 * triage / orientation. A 500-line `read_file_at_ref` lands as ~5K tokens in
 * the conversation, then sits in the cache pool for every subsequent turn
 * (re-billed at the cache-read rate). When Sonnet just wants "what does this
 * file do?" or "how does foo work?" the bytes themselves are not what's
 * needed — a 5-line summary plus a few line-specific flags is enough.
 *
 * This tool reads the file inside the handler, hands the bytes to a Haiku
 * worker, and returns a structured summary. The parent's conversation only
 * carries the summary (a few hundred tokens), not the raw file content.
 *
 * Verification discipline (deliberate non-decision):
 *   - This tool does NOT call recordHeadRead. The validator (validate-comment.ts)
 *     requires read_file_at_ref before any critical/important post. A worker
 *     summary is not a substitute for Sonnet actually reading the bytes —
 *     Haiku at 28% recall as a top-level agent is the canonical reason. Worker
 *     output is a hint, not evidence. The tool description tells Sonnet so.
 */

import { z } from 'zod';
import { BudgetError } from '../util/errors.js';
import { jsonResult, type ToolDeps } from './types.js';
import { tool } from './tool-helper.js';

const MAX_LINES_PER_CALL = 500;
const WORKER_MAX_TOKENS = 1536;

const summarySchema = z.object({
  summary: z
    .string()
    .min(1)
    .max(800)
    .describe('2-3 sentence description of what the file does'),
  focused_answer: z
    .string()
    .min(1)
    .max(800)
    .describe("Direct answer to the reviewer's focus_question, citing line numbers when possible"),
  flags_for_deeper_look: z
    .array(
      z.object({
        line: z.number().int().positive(),
        concern: z.string().min(1).max(240),
      }),
    )
    .max(8)
    .default([]),
  total_lines: z.number().int().nonnegative(),
  reviewed_range: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
});

const WORKER_SYSTEM_PROMPT = `You are a code summarization worker assisting a senior reviewer.

You receive a file (or a range of one) plus a focus question. Your job is to extract structured facts — NOT to make judgment calls about code quality, and NOT to propose fixes.

Return ONLY JSON matching this schema (no markdown fences, no prose before or after):

{
  "summary": "2-3 sentence description of what this file does, in plain language. Be specific: name exports, describe the main flow, note external dependencies. 'It has functions' is useless. 'Exports authenticate(req, res) at line 42 (validates Bearer token, calls db.users.findById) and refreshToken(token) at line 88 (signs new JWT with HS256)' is useful.",
  "focused_answer": "Direct answer to the reviewer's focus_question. Cite line numbers. If the answer is 'no' or 'not present', say so explicitly with the lines you looked at.",
  "flags_for_deeper_look": [
    { "line": N, "concern": "1-sentence hint about what might be worth investigating at this line" }
  ],
  "total_lines": N,
  "reviewed_range": [start, end]
}

Rules:
- flags_for_deeper_look must cite SPECIFIC LINES, not general observations. "line 67: catches Error but doesn't log it" — not "error handling could be better".
- Return up to 5 flags, prioritized by what the focus_question suggests the reviewer is hunting for.
- If the file is uninteresting for the focus_question (trivial re-exports, generated code, pure type definitions), return an empty flags array.
- focused_answer must be a direct answer, not "this file does X and also Y" prose. If the question is "is there error handling on the network call?", the answer is "Yes at line 47 (try/catch around fetch); no at line 92 (raw await)" — concise and specific.`;

export function makeWorkerSummarizeFileTool(deps: ToolDeps) {
  return tool(
    'worker_summarize_file',
    'Get a structured summary of a file from a cheap worker (claude-haiku-4-5). ' +
      'Use this for orientation / triage ("what does this file do?", "how is X wired up?") ' +
      'INSTEAD OF read_file_at_ref when you only need 5 lines of context rather than 500 ' +
      'lines of raw bytes in your conversation. Returns a structured summary, a direct ' +
      'answer to your focus_question, and line-specific flags worth deeper investigation.\n\n' +
      'IMPORTANT: Worker output is a HINT, not evidence. For critical/important findings ' +
      'you MUST still call read_file_at_ref on the target line range yourself before ' +
      'post_inline_comment — the validator will reject otherwise. For minor/nit findings ' +
      'or pure orientation, worker summary alone is fine.\n\n' +
      'Cost: ~$0.005-0.01 per call vs ~$0.02-0.05 worth of cache-pool weight from a 500-' +
      'line raw file read that lingers for every subsequent turn.',
    {
      path: z.string().describe('Repo-relative path, e.g. "src/auth/middleware.ts".'),
      focus_question: z
        .string()
        .min(8)
        .max(400)
        .describe(
          'What you want to know about this file. The more specific, the more useful the ' +
            'answer. Example: "Is there error handling on the call to db.users.update?" — ' +
            'not "tell me about this file".',
        ),
      ref: z
        .enum(['head', 'base'])
        .default('head')
        .describe('Which side of the PR to read: head (post-PR) or base (pre-PR).'),
      start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional first line (1-indexed). Omit to summarize from line 1 (or full file ' +
            'if under the 500-line cap).',
        ),
      end_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Optional last line (1-indexed). Capped at start_line + 500. Omit to read up to ' +
            'the cap.',
        ),
    },
    async (args) => {
      if (deps.worker === undefined) {
        return jsonResult({
          ok: false,
          error: 'worker delegation is not enabled in this run',
          hint: 'Set experimental.worker_delegation.enabled = true in .code-review.yml to use this tool.',
        });
      }

      const sha =
        args.ref === 'head'
          ? deps.prContext.metadata.head_sha
          : deps.prContext.metadata.base_sha;

      const start = args.start_line ?? 1;
      const requestedEnd = args.end_line ?? Number.MAX_SAFE_INTEGER;
      const end = Math.min(requestedEnd, start + MAX_LINES_PER_CALL - 1);

      const result = await deps.fileReader.readRange(
        { owner: deps.owner, repo: deps.repo, path: args.path, ref: sha },
        start,
        end,
      );
      if (result === null) {
        return jsonResult({
          ok: false,
          error: `File '${args.path}' not found at ${args.ref} (${sha.slice(0, 7)})`,
          hint: 'Check list_changed_files for the exact paths in this PR.',
        });
      }

      const range = (result as { returned_range?: [number, number] }).returned_range;
      const [readStart, readEnd] = range ?? [start, end];
      const totalLines =
        (result as { total_lines?: number }).total_lines ?? readEnd - readStart + 1;
      const content = (result as { content?: string }).content ?? '';

      const userPrompt = renderUserPrompt({
        path: args.path,
        focus_question: args.focus_question,
        content,
        readStart,
        readEnd,
        totalLines,
        ref: args.ref,
      });

      try {
        const { parsed } = await deps.worker.invoke({
          task: 'summarize_file',
          systemPrompt: WORKER_SYSTEM_PROMPT,
          userPrompt,
          maxTokens: WORKER_MAX_TOKENS,
          responseSchema: summarySchema,
        });

        return jsonResult({
          ok: true,
          path: args.path,
          ref: args.ref,
          ref_sha: sha,
          ...parsed,
          reminder:
            'Worker summary is a hint, not evidence. For critical/important findings, ' +
            'call read_file_at_ref on the target lines before posting.',
        });
      } catch (err) {
        // BudgetError must escape so the runner can flip to 'budget_exceeded'.
        // Other worker errors are recoverable — Sonnet should fall back to
        // read_file_at_ref itself.
        if (err instanceof BudgetError) throw err;
        return jsonResult({
          ok: false,
          error: `worker summarize failed: ${(err as Error).message}`,
          hint: 'Fall back to read_file_at_ref for this file.',
        });
      }
    },
  );
}

function renderUserPrompt(args: {
  path: string;
  focus_question: string;
  content: string;
  readStart: number;
  readEnd: number;
  totalLines: number;
  ref: 'head' | 'base';
}): string {
  const lines: string[] = [];
  lines.push(`## Focus question`);
  lines.push(args.focus_question);
  lines.push('');
  lines.push(`## File`);
  lines.push(
    `Path: \`${args.path}\` @ ${args.ref}` +
      ` (lines ${args.readStart}-${args.readEnd} of ${args.totalLines} total)`,
  );
  lines.push('');
  lines.push('```');
  lines.push(args.content);
  lines.push('```');
  lines.push('');
  lines.push(`## Required output`);
  lines.push(
    `Return ONLY the JSON described in your instructions. Set "reviewed_range" to [${args.readStart}, ${args.readEnd}] and "total_lines" to ${args.totalLines}.`,
  );
  return lines.join('\n');
}
