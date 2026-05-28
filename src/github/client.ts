/**
 * Octokit factory with retry and throttling plugins for resilience.
 */
import { Octokit } from '@octokit/rest';
import { retry as retryPlugin } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { logger } from '../util/logger.js';

const OctokitWithPlugins = Octokit.plugin(retryPlugin, throttling);

export interface ClientOptions {
  auth: string;
  userAgent?: string;
  baseUrl?: string;
}

export function createOctokit(opts: ClientOptions): Octokit {
  return new OctokitWithPlugins({
    auth: opts.auth,
    userAgent: opts.userAgent ?? 'driches/vor',
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        const method = (options as { method?: string }).method ?? 'GET';
        const url = (options as { url?: string }).url ?? 'unknown';
        void logger.warn(
          `Rate limited on ${method} ${url} — retrying after ${retryAfter}s (attempt ${retryCount + 1})`,
        );
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        const method = (options as { method?: string }).method ?? 'GET';
        const url = (options as { url?: string }).url ?? 'unknown';
        void logger.warn(`Secondary rate limit on ${method} ${url} — backing off ${retryAfter}s`);
        return true;
      },
    },
    // `@octokit/plugin-retry` compares `error.status` (a number) against
    // these entries with `Array.prototype.includes`, which uses strict
    // equality — strings don't match numeric statuses. Passing numbers
    // ensures 4xx errors actually short-circuit retries; with strings the
    // plugin retries 404s 3 extra times, wasting API quota on every
    // missing optional file (.vor.yml, AGENTS.md, CLAUDE.md).
    retry: { doNotRetry: [400, 401, 403, 404, 422] },
  });
}
