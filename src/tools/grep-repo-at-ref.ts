import { tool } from './tool-helper.js';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';
import { runGitGrep } from '../util/git-grep.js';

const HARD_RESULT_CAP = 200;

export function makeGrepRepoAtRefTool(deps: ToolDeps) {
  return tool(
    'grep_repo_at_ref',
    'Searches the repo for a regex pattern at HEAD. Use this BEFORE commenting ' +
      '"this is unused" / "we have a helper for this" / "breaks the pattern". ' +
      'Optional path_glob to restrict scope. Runs against the local working tree ' +
      '(checked out at PR HEAD).',
    {
      pattern: z.string().min(1).describe('Regex pattern, ERE syntax (git grep -E).'),
      ref: z
        .enum(['head'])
        .default('head')
        .describe('Only "head" is supported (the checkout reflects PR HEAD).'),
      path_glob: z
        .string()
        .optional()
        .describe('Path glob to restrict the search, e.g., "src/**/*.ts".'),
      max_results: z
        .number()
        .int()
        .positive()
        .max(HARD_RESULT_CAP)
        .default(50)
        .describe('Max matches to return.'),
      case_sensitive: z.boolean().default(true),
    },
    async (args) => {
      const cap = Math.min(args.max_results, HARD_RESULT_CAP);
      try {
        const result = await runGitGrep({
          pattern: args.pattern,
          cwd: deps.workspaceDir,
          caseSensitive: args.case_sensitive,
          pathGlob: args.path_glob,
          maxResults: cap,
        });
        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          matches: [],
          total: 0,
          truncated: false,
          error: (err as Error).message,
        });
      }
    },
  );
}
