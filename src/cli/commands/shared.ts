import { status } from '../output.js';

/** Resolve the workspace a CLI command operates on. */
export function workspace(): string {
  return process.cwd();
}

/**
 * Exit early with a clear message when no model API key is configured. The
 * orchestrator would otherwise skip the review with a `skipped_no_key_*`
 * outcome, which is confusing on the command line.
 */
export function requireApiKey(): void {
  const hasKey =
    (process.env.ANTHROPIC_API_KEY?.trim().length ?? 0) > 0 ||
    (process.env.OPENAI_API_KEY?.trim().length ?? 0) > 0;
  if (!hasKey) {
    status('No model API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and retry.');
    process.exit(2);
  }
}
