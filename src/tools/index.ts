/**
 * Barrel export for the tool factories. Each factory takes ToolDeps and
 * returns a tool definition (name + description + Zod input shape + handler).
 *
 * The runner consumes these directly — it converts the Zod shape to a JSON
 * Schema and pairs the handler with the Anthropic SDK's tool-use loop. There
 * is no MCP transport; the tools execute in-process.
 */

export { makeGetPrMetadataTool } from './get-pr-metadata.js';
export { makeListChangedFilesTool } from './list-changed-files.js';
export { makeGetPrDiffTool } from './get-pr-diff.js';
export { makeReadFileAtRefTool } from './read-file-at-ref.js';
export { makeGrepRepoAtRefTool } from './grep-repo-at-ref.js';
export { makeReadRepoContextFileTool } from './read-repo-context-file.js';
export { makePostInlineCommentTool } from './post-inline-comment.js';
export { makePostSummaryTool } from './post-summary.js';
export { makeSkipFileTool } from './skip-file.js';

export type { ToolDeps } from './types.js';
export type { SdkToolDefinition, SdkToolResult } from './tool-helper.js';
