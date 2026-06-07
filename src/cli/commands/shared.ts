import { repoRoot } from '../../local/git.js';
import { status } from '../output.js';

/**
 * Resolve the workspace a CLI command operates on — the repository root, not the
 * raw cwd. `runLocalReview` saves run records under the repo-root project slug,
 * so the history commands (`runs list/show`) must read from the same root or a
 * review started in a subdirectory would be invisible to them.
 */
export function workspace(): string {
  return repoRoot(process.cwd());
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
