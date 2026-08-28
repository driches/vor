/**
 * GitHub Actions entry for the review orchestrator.
 *
 * The shared review pipeline lives in `platform/runner.ts`; this file keeps
 * the existing GitHub-shaped public API intact and wires it to the GitHub
 * platform adapter.
 */

import type { Octokit } from '@octokit/rest';
import type { LLMProvider, ProviderId } from './llm/index.js';
import { createGitHubPlatform } from './platform/github.js';
import { assertValidProviderOverride } from './platform/model-selection.js';
import { runReviewWithPlatform, type OrchestratorOutput } from './platform/runner.js';

export type { OrchestratorOutput } from './platform/runner.js';

export interface OrchestratorInput {
  owner: string;
  repo: string;
  pull_number: number;
  anthropic_api_key: string;
  /** OpenAI API key. Empty string when not configured (fork-PR / Claude-only setups). */
  openai_api_key: string;
  github_token: string;
  model_override?: string;
  /**
   * Explicit provider routing override sourced from action.yml's `provider`
   * input (env var `INPUT_PROVIDER`). Flat to match `model_override` — each
   * has independent provenance from the action inputs.
   */
  provider_override?: ProviderId;
  max_turns_override?: number;
  config_path: string;
  dry_run: boolean;
  workspace_dir: string;
  /**
   * Optional override forwarded to `runAgent`. Production omits this and the
   * runner uses the real `createProvider`. The eval harness
   * (`scripts/eval/orchestrator-adapter.ts`) passes a stub here so it can
   * script per-turn provider responses without mocking `@anthropic-ai/sdk`
   * or `openai` at module scope. See `RunAgentInput.providerFactory`.
   */
  providerFactory?: (input: {
    modelId: string;
    apiKey: string;
    providerHint?: ProviderId;
  }) => LLMProvider;
  /**
   * Optional override for Octokit instantiation. Production omits this and
   * `createOctokit` is used against the real GitHub API. The local-review
   * CLI (`scripts/local-review.ts`) injects a git-backed FakeOctokit here
   * so the same `runOrchestrator` path runs against the user's working
   * copy with no GitHub round-trip. Same shape as `providerFactory`.
   */
  octokitFactory?: (opts: { auth: string }) => Octokit;
}

export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  assertValidProviderOverride(input.provider_override);
  const platform = createGitHubPlatform({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pull_number,
    github_token: input.github_token,
    ...(input.octokitFactory !== undefined ? { octokitFactory: input.octokitFactory } : {}),
  });

  return runReviewWithPlatform({
    platform,
    anthropic_api_key: input.anthropic_api_key,
    openai_api_key: input.openai_api_key,
    ...(input.model_override !== undefined ? { model_override: input.model_override } : {}),
    ...(input.provider_override !== undefined
      ? { provider_override: input.provider_override }
      : {}),
    ...(input.max_turns_override !== undefined
      ? { max_turns_override: input.max_turns_override }
      : {}),
    config_path: input.config_path,
    dry_run: input.dry_run,
    workspace_dir: input.workspace_dir,
    ...(input.providerFactory !== undefined ? { providerFactory: input.providerFactory } : {}),
  });
}
