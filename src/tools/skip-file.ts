import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';

export function makeSkipFileTool(deps: ToolDeps) {
  return tool(
    'skip_file',
    'Explicitly mark a file as reviewed-with-nothing-to-say. Useful for generated ' +
      'files, lockfiles, or trivial renames. Helps the runner verify coverage.',
    {
      file_path: z.string().describe('Path of the file to skip.'),
      reason: z.enum(['generated', 'lockfile', 'trivial-rename', 'no-issues', 'out-of-scope']),
    },
    async (args) => {
      const inPR = deps.prContext.files.some((f) => f.path === args.file_path);
      if (!inPR) {
        return jsonResult({
          accepted: false,
          reason: `file_path '${args.file_path}' is not in this PR`,
          hint: 'Call list_changed_files to see valid paths.',
        });
      }
      deps.aggregator.addSkipped({ file_path: args.file_path, reason: args.reason });
      return jsonResult({ accepted: true });
    },
  );
}
