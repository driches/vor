import type { ProviderId } from '../llm/types.js';
import type { Severity, ReviewEvent } from '../types.js';

export interface ReviewConfig {
  model: string;
  /**
   * Explicit LLM provider override. When omitted, the provider is inferred
   * from `model` (`claude-*` → anthropic, `gpt-*` / `o<digit>*` / `chatgpt-*`
   * → openai). Set this when using a model id that doesn't match a known
   * prefix.
   */
  provider?: ProviderId;
  max_turns: number;

  exclude: {
    paths: string[];
    max_diff_lines_per_file: number;
  };

  focus: {
    security: boolean;
    performance: boolean;
    correctness: boolean;
    style: boolean;
    tests: boolean;
    docs: boolean;
  };

  severity: {
    floor: Severity;
    max_comments_per_file: number;
    max_comments_total: number;
  };

  context: {
    include: string[];
    max_context_bytes: number;
  };

  prompt: {
    additions: string;
  };

  review: {
    event: ReviewEvent;
    sticky: boolean;
    post_summary: boolean;
  };

  budget: {
    max_input_tokens: number;
    max_output_tokens: number;
  };

  security: SecurityConfig;

  /** Provider-specific request controls. Defaults are conservative. */
  providers: ProviderConfig;

  /**
   * Opt-in feature flags. Default-disabled features land here so they ship
   * without changing behavior for anyone who hasn't opted in.
   */
  experimental: ExperimentalConfig;
}

export interface ProviderConfig {
  openai: OpenAIProviderConfig;
}

export interface OpenAIProviderConfig {
  /** Responses API service tier. `flex` can reduce cost with slower/less available processing. */
  service_tier?: 'auto' | 'default' | 'flex';
  /** Stable cache-routing key for prompt caching. Keep low-cardinality. */
  prompt_cache_key?: string;
  /** Prompt cache retention policy when supported by the selected model. */
  prompt_cache_retention?: 'in_memory' | '24h';
  /** Reasoning effort for reasoning-capable OpenAI models. */
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** GPT-5 text verbosity knob when supported. */
  text_verbosity?: 'low' | 'medium' | 'high';
}

export interface ExperimentalConfig {
  /**
   * Lets the main agent delegate verification work (is `foo` unused? does
   * `bar` have one caller?) to a cheap Haiku worker via the
   * `worker_check_usage_claim` tool. Sonnet still verifies the bytes itself
   * before posting critical/important findings (validator-enforced). Default
   * off — opt in per repo via `.code-review.yml`.
   */
  worker_delegation: WorkerDelegationConfig;
}

export interface WorkerDelegationConfig {
  enabled: boolean;
  /** Model id used for worker calls. Defaults to claude-haiku-4-5. */
  worker_model: string;
}

export interface ScannerConfig {
  enabled: boolean;
  min_severity?: Severity;
}

export interface SecurityConfig {
  enabled: boolean;
  ignore_file: string;
  scanners: {
    dependency_cve: ScannerConfig & { osv_endpoint?: string };
    secrets: ScannerConfig & { include_generic_entropy: boolean };
    sast: SastConfig;
    container_cve: ScannerConfig;
    /**
     * Opt-in coverage-delta scanner. Runs the repo's existing test coverage
     * tool (vitest / jest / pytest-cov) and emits a finding on every PR-added
     * line that isn't exercised by the test suite. Opt-in (not default) because
     * coverage runs can be slow and require the project's test deps to be
     * installed in the workspace.
     */
    coverage_delta: ScannerConfig;
  };
  cache: { enabled: boolean };
  persistence: { enabled: boolean };
}

export interface SastConfig extends ScannerConfig {
  semgrep?: SemgrepConfig;
  /**
   * Per-linter opt-out for the TypeScript compiler scanner. When the `tsc`
   * block is omitted entirely, the linter is ON by default (matching the
   * "scanners are enabled unless turned off" stance of the top-level
   * `sast.enabled` flag). Set `{ enabled: false }` to disable tsc without
   * disabling the rest of the sast fan-out (e.g. a repo that prefers to
   * run tsc as its own CI step and doesn't want duplicate findings).
   */
  tsc?: { enabled?: boolean };
}

export interface SemgrepConfig {
  /**
   * Path (relative to the workspace root, or absolute) to a directory of
   * custom Semgrep rule YAMLs that should be loaded *in addition to* the
   * built-in `--config=auto` ruleset. When set and present on disk, the
   * orchestrator appends `--config <abs_path>` to the semgrep invocation;
   * Semgrep merges multiple `--config` flags into a single rule set.
   *
   * Resolves silently when the path is unset OR is configured but missing
   * on disk — repos that don't ship rules just get the default ruleset.
   * Defaults to `'.code-review/semgrep-rules'`, which is the conventional
   * location the action's bundled rule pack ships at.
   */
  custom_rules_path?: string;
}
