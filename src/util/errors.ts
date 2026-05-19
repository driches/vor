/**
 * Typed error hierarchy. Caught at the orchestrator level for consistent logging.
 */

export class CodeReviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ConfigError extends CodeReviewError {}

export class GitHubApiError extends CodeReviewError {
  constructor(
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class AgentError extends CodeReviewError {}

export class BudgetError extends CodeReviewError {}
