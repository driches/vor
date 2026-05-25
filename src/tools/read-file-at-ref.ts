import { tool } from './tool-helper.js';
import { z } from 'zod';
import { recordHeadRead } from '../agent/run-context.js';
import { jsonResult, type ToolDeps } from './types.js';

const MAX_LINES_PER_CALL = 500;

export function makeReadFileAtRefTool(deps: ToolDeps) {
  return tool(
    'read_file_at_ref',
    'Reads file content at HEAD or BASE of the PR. Use this BEFORE high-severity ' +
      'findings to verify surrounding context. Optional start_line/end_line range. ' +
      'Range is capped at 500 lines per call; for larger files, make multiple calls.',
    {
      path: z.string().describe('Repo-relative path, e.g., "src/foo.ts".'),
      ref: z
        .enum(['head', 'base'])
        .default('head')
        .describe('Which side to read: head (post-PR) or base (pre-PR).'),
      start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('First line to return (1-indexed, inclusive).'),
      end_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Last line to return (1-indexed, inclusive). Capped to start+500.'),
    },
    async (args) => {
      const sha = args.ref === 'head' ? deps.prContext.metadata.head_sha : deps.prContext.metadata.base_sha;

      const start = args.start_line ?? 1;
      const requestedEnd = args.end_line ?? Number.MAX_SAFE_INTEGER;
      const end = Math.min(requestedEnd, start + MAX_LINES_PER_CALL - 1);

      if (args.start_line !== undefined || args.end_line !== undefined) {
        const result = await deps.fileReader.readRange(
          { owner: deps.owner, repo: deps.repo, path: args.path, ref: sha },
          start,
          end,
        );
        if (result == null) {
          return jsonResult({
            ok: false,
            error: `File '${args.path}' not found at ${args.ref} (${sha.slice(0, 7)})`,
            hint: 'Check list_changed_files for the exact paths in this PR.',
          });
        }
        if (args.ref === 'head') {
          // Use the actual returned range (the reader may clip to file
          // length). Falls back to the requested range if the reader didn't
          // report one.
          const range = (result as { returned_range?: [number, number] }).returned_range;
          const [s, e] = range ?? [start, end];
          recordHeadRead(deps.runContext, args.path, s, e);
        }
        return jsonResult({
          ok: true,
          ...result,
          ref: args.ref,
          ref_sha: sha,
          path: args.path,
        });
      }

      const content = await deps.fileReader.read({
        owner: deps.owner,
        repo: deps.repo,
        path: args.path,
        ref: sha,
      });
      if (content == null) {
        return jsonResult({
          ok: false,
          error: `File '${args.path}' not found at ${args.ref} (${sha.slice(0, 7)})`,
          hint: 'Check list_changed_files for the exact paths in this PR.',
        });
      }
      const lines = content.split('\n');
      const total = lines.length;
      const truncated = total > MAX_LINES_PER_CALL;
      const returned = truncated ? lines.slice(0, MAX_LINES_PER_CALL).join('\n') : content;
      const returnedEnd = truncated ? MAX_LINES_PER_CALL : total;
      if (args.ref === 'head') {
        recordHeadRead(deps.runContext, args.path, 1, returnedEnd);
      }
      return jsonResult({
        ok: true,
        content: returned,
        total_lines: total,
        returned_range: [1, returnedEnd],
        truncated,
        ref: args.ref,
        ref_sha: sha,
        path: args.path,
      });
    },
  );
}
