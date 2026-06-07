/**
 * Shared types for the local-review surface (CLI, dashboard, MCP).
 */

import type { OrchestratorOutput } from '../orchestrator.js';

/** What `vor review` should diff. `auto` picks working-tree when the tree is
 *  dirty, otherwise range. */
export type ReviewTarget = 'auto' | 'working-tree' | 'range';

/** The target after `auto` has been resolved to a concrete shape. */
export type ResolvedTarget = 'working-tree' | 'range';

export interface RunRef {
  /** Human-readable ref label (e.g. `origin/main`, `HEAD`, `working-tree`). */
  ref: string;
  /** Resolved commit SHA, or null for the uncommitted working tree. */
  sha: string | null;
}

/**
 * A persisted local review. Wraps the orchestrator's output (the eval contract,
 * including `kept_comments`) with the provenance needed to list and re-open the
 * run in the CLI / dashboard.
 */
export interface LocalRunRecord {
  /** Sortable, filesystem-safe id (timestamp + short random suffix). */
  id: string;
  timestamp: string;
  target: ResolvedTarget;
  base: RunRef;
  head: RunRef;
  workspace: string;
  project_slug: string;
  config_path: string;
  files: number;
  additions: number;
  deletions: number;
  result: OrchestratorOutput;
}

export interface LocalReviewOptions {
  workspace?: string;
  target?: ReviewTarget;
  /** Base ref for range mode. Defaults to `origin/main`. */
  base?: string;
  /** Head ref for range mode. Defaults to `HEAD`. */
  head?: string;
  model?: string;
  configPath?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}
