import type { Severity, ReviewEvent } from '../types.js';

export interface ReviewConfig {
  model: string;
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

  /**
   * Opt-in feature flags. Default-disabled features land here so they ship
   * without changing behavior for anyone who hasn't opted in.
   */
  experimental: ExperimentalConfig;
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
    sast: ScannerConfig;
    container_cve: ScannerConfig;
  };
  cache: { enabled: boolean };
  persistence: { enabled: boolean };
}
