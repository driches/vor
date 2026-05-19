/**
 * Builds the MCP server with all custom tools registered.
 * The agent receives ONLY these tools (built-in Read/Edit/Bash disabled via
 * `tools: []` in the query options).
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { makeGetPrDiffTool } from './get-pr-diff.js';
import { makeGetPrMetadataTool } from './get-pr-metadata.js';
import { makeGrepRepoAtRefTool } from './grep-repo-at-ref.js';
import { makeListChangedFilesTool } from './list-changed-files.js';
import { makePostInlineCommentTool } from './post-inline-comment.js';
import { makePostSummaryTool } from './post-summary.js';
import { makeReadFileAtRefTool } from './read-file-at-ref.js';
import { makeReadRepoContextFileTool } from './read-repo-context-file.js';
import { makeSkipFileTool } from './skip-file.js';
import type { ToolDeps } from './types.js';

export const MCP_SERVER_NAME = 'pr-review';

export const TOOL_NAMES = [
  'get_pr_metadata',
  'list_changed_files',
  'get_pr_diff',
  'read_file_at_ref',
  'grep_repo_at_ref',
  'read_repo_context_file',
  'post_inline_comment',
  'post_summary',
  'skip_file',
] as const;

/** Names as the agent sees them (mcp__<server>__<tool>). */
export const QUALIFIED_TOOL_NAMES = TOOL_NAMES.map(
  (n) => `mcp__${MCP_SERVER_NAME}__${n}`,
);

export function buildToolServer(deps: ToolDeps) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      makeGetPrMetadataTool(deps),
      makeListChangedFilesTool(deps),
      makeGetPrDiffTool(deps),
      makeReadFileAtRefTool(deps),
      makeGrepRepoAtRefTool(deps),
      makeReadRepoContextFileTool(deps),
      makePostInlineCommentTool(deps),
      makePostSummaryTool(deps),
      makeSkipFileTool(deps),
    ],
  });
}

export type { ToolDeps } from './types.js';
