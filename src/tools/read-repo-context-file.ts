import { tool } from './tool-helper.js';
import { z } from 'zod';
import { jsonResult, REPO_CONTEXT_FILES, type ToolDeps } from './types.js';

export function makeReadRepoContextFileTool(deps: ToolDeps) {
  return tool(
    'read_repo_context_file',
    'Reads one or more repo-convention files (CLAUDE.md, AGENTS.md, package.json, ' +
      'tsconfig.json, README.md, .code-review.yml, etc.) at HEAD. Call this EARLY ' +
      '(turn 2 or 3) to ground your judgments in the repo\'s actual conventions. ' +
      'Returns content for each file or { exists: false }.',
    {
      files: z
        .array(z.enum(REPO_CONTEXT_FILES))
        .optional()
        .describe('Files to read. Defaults to all whitelisted files.'),
    },
    async (args) => {
      const targets = args.files ?? [...REPO_CONTEXT_FILES];
      const sha = deps.prContext.metadata.head_sha;
      const results: Record<string, { exists: boolean; content?: string }> = {};

      for (const file of targets) {
        const content = await deps.fileReader.read({
          owner: deps.owner,
          repo: deps.repo,
          path: file,
          ref: sha,
        });
        if (content == null) {
          results[file] = { exists: false };
        } else {
          results[file] = { exists: true, content };
        }
      }
      return jsonResult(results);
    },
  );
}
