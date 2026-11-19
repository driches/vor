import { tool } from './tool-helper.js';
import { z } from 'zod';
import { jsonResult, REPO_CONTEXT_FILES, type ToolDeps } from './types.js';

export function makeReadRepoContextFileTool(deps: ToolDeps) {
  return tool(
    'read_repo_context_file',
    'Reads one or more repo-convention files (CLAUDE.md, AGENTS.md, package.json, ' +
      'tsconfig.json, README.md, .vor.yml, etc.) at HEAD. Call this EARLY ' +
      "(turn 2 or 3) to ground your judgments in the repo's actual conventions. " +
      'Returns content for each file or { exists: false }. A file whose full text is ' +
      'already in your system prompt under "Repo context" comes back as ' +
      '{ exists: true, in_system_prompt: true } without repeating it.',
    {
      files: z
        .array(z.enum(REPO_CONTEXT_FILES))
        .optional()
        .describe('Files to read. Defaults to all whitelisted files.'),
    },
    async (args) => {
      const targets = args.files ?? [...REPO_CONTEXT_FILES];
      const sha = deps.prContext.metadata.head_sha;
      const results: Record<
        string,
        { exists: boolean; content?: string; in_system_prompt?: boolean }
      > = {};

      for (const file of targets) {
        if (deps.embeddedContextFiles?.has(file)) {
          results[file] = { exists: true, in_system_prompt: true };
          continue;
        }
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
