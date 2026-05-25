/**
 * Shared types for tool handlers.
 */
import type { Octokit } from '@octokit/rest';
import type { FileReader } from '../github/file-reader.js';
import type { PRContext } from '../github/pr-context.js';
import type { RunContext } from '../agent/run-context.js';
import type { WorkerClient } from '../agent/worker.js';
import type { ReviewAggregator } from '../output/aggregator.js';
import type { ReviewConfig } from '../config/types.js';

export interface ToolDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
  pull_number: number;
  prContext: PRContext;
  fileReader: FileReader;
  aggregator: ReviewAggregator;
  config: ReviewConfig;
  /** Local checkout root (GITHUB_WORKSPACE in CI). Used for grep_repo_at_ref. */
  workspaceDir: string;
  /**
   * Per-run mutable state (read ranges for validator enforcement, etc.).
   * Created fresh in runAgent per invocation; tool handlers may mutate it.
   */
  runContext: RunContext;
  /**
   * Optional Haiku worker client. Present only when
   * `experimental.worker_delegation.enabled` is true; tool factories that
   * need it should fail fast when it's missing.
   */
  worker?: WorkerClient;
}

/** Helper: build the text-content shape MCP tools return. */
export function textResult(text: string, isError = false): {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Helper for JSON-shaped responses. */
export function jsonResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** Whitelist of repo context files the agent can request. */
export const REPO_CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.code-review.yml',
  'package.json',
  'tsconfig.json',
  'README.md',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
] as const;
export type RepoContextFile = (typeof REPO_CONTEXT_FILES)[number];
