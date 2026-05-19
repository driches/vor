/**
 * Shared test helpers for building fake ToolDeps and parsing tool results.
 */
import type { ReviewConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { FileReader } from '../github/file-reader.js';
import type { PRContext, PRMetadata } from '../github/pr-context.js';
import { ReviewAggregator } from '../output/aggregator.js';
import type { ChangedFile } from '../types.js';
import type { ToolDeps } from './types.js';

export interface FakeDepsInput {
  files?: ChangedFile[];
  metadata?: Partial<PRMetadata>;
  diff?: string;
  config?: Partial<ReviewConfig>;
  fileReader?: Partial<FileReader>;
  workspaceDir?: string;
}

export function buildFakeDeps(input: FakeDepsInput = {}): ToolDeps {
  const metadata: PRMetadata = {
    number: 1,
    title: 'Test PR',
    body: '',
    author: 'tester',
    base_sha: 'b'.repeat(40),
    head_sha: 'h'.repeat(40),
    base_ref: 'main',
    head_ref: 'feature',
    labels: [],
    changed_file_count: input.files?.length ?? 0,
    additions: 0,
    deletions: 0,
    draft: false,
    ...input.metadata,
  };

  const prContext: PRContext = {
    metadata,
    files: input.files ?? [],
    diff: input.diff ?? '',
  };

  const config: ReviewConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
  };

  const fileReader = (input.fileReader as unknown as FileReader) ?? {
    read: async () => null,
    readRange: async () => null,
  };

  return {
    octokit: {} as ToolDeps['octokit'],
    owner: 'owner',
    repo: 'repo',
    pull_number: 1,
    prContext,
    fileReader,
    aggregator: new ReviewAggregator(),
    config,
    workspaceDir: input.workspaceDir ?? process.cwd(),
  };
}

export function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 5,
    deletions: 1,
    reviewable_lines: [[10, 15]],
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 200,
    head_line_text: new Map([[10, 'const x = 1;']]),
    ...over,
  };
}

/** Pull the text content out of a CallToolResult shape (loose typing). */
export function getResultText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content[0]?.text ?? '';
}

/** Parse the JSON wrapped in a textResult. */
export function getResultJson(result: unknown): unknown {
  return JSON.parse(getResultText(result));
}

/**
 * Invokes a tool's handler with permissive arg typing. Useful in tests because
 * the SDK's InferShape treats Zod-optional fields as required-with-undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callTool(tool: any, args: Record<string, unknown>): Promise<unknown> {
  return tool.handler(args, undefined);
}
