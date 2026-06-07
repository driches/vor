/**
 * Builds a git-backed FakeOctokit that satisfies the Octokit surface the
 * orchestrator + scanners + agent tools actually touch during a dry-run review,
 * sourced entirely from a local git working copy — no GitHub round-trip.
 *
 * Generalized from scripts/local-review.ts so the head side can be either a
 * committed ref (range mode) or the working tree (working-tree mode). The
 * caller supplies a `resolveContent(path, ref)` so this module stays agnostic
 * about where head content lives; review.ts wires disk vs `git show`.
 */

import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from './git.js';

export interface FakeOctokitOptions {
  baseSha: string;
  /** Head identifier surfaced as the PR head SHA. A sentinel in working-tree mode. */
  headSha: string;
  files: ChangedFile[];
  diff: string;
  prMeta: {
    title: string;
    body: string;
    author: string;
    additions: number;
    deletions: number;
  };
  /**
   * Resolve file content for a `repos.getContent` call. `ref` is whatever the
   * caller passed (or the head SHA when omitted). Returns null when the path
   * does not exist at that ref, which is mapped to a 404 the way the GitHub API
   * would respond. Content overrides (e.g. a synthetic `.vor.yml`) should be
   * honored inside this resolver by the caller.
   */
  resolveContent: (path: string, ref: string) => string | null;
}

export function buildLocalOctokit(opts: FakeOctokitOptions): Octokit {
  // GitHub's listFiles shape has `filename`, `status`, `additions`, `deletions`,
  // `changes`, `patch`. The orchestrator only needs filename + status +
  // additions/deletions; per-file patch is read from the unified diff instead.
  const fileApi = opts.files.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    previous_filename: f.previous_path,
    sha: opts.headSha,
  }));

  const notImplemented =
    (method: string) =>
    async (..._args: unknown[]): Promise<never> => {
      throw new Error(
        `local FakeOctokit: ${method} is not implemented — extend buildLocalOctokit if a code path requires it.`,
      );
    };

  // Cast through unknown because we only implement the surface used; the full
  // Octokit interface has hundreds of methods we don't need.
  return {
    rest: {
      pulls: {
        get: async (args: { mediaType?: { format?: string } }) => {
          if (args.mediaType?.format === 'diff') {
            return { data: opts.diff as unknown };
          }
          return {
            data: {
              number: 0,
              title: opts.prMeta.title,
              body: opts.prMeta.body,
              user: { login: opts.prMeta.author },
              draft: false,
              additions: opts.prMeta.additions,
              deletions: opts.prMeta.deletions,
              changed_files: fileApi.length,
              labels: [],
              head: { sha: opts.headSha, ref: 'local-head' },
              base: { sha: opts.baseSha, ref: 'local-base' },
            },
          };
        },
        listFiles: async () => ({ data: fileApi }),
        // Sticky dismissal lookup: no prior reviews to dismiss.
        listReviews: async () => ({ data: [] }),
        // Prior-thread fetch: a local working copy has no prior PR threads.
        listReviewComments: async () => ({ data: [] }),
        dismissReview: notImplemented('pulls.dismissReview'),
        // Dry-run never reaches createReview, but stub it for safety.
        createReview: async () => ({ data: { id: 0 } }),
      },
      repos: {
        getContent: async (args: { path: string; ref?: string }) => {
          const ref = args.ref ?? opts.headSha;
          const content = opts.resolveContent(args.path, ref);
          if (content === null) {
            const err = Object.assign(new Error('Not Found'), { status: 404 });
            throw err;
          }
          return {
            data: {
              type: 'file',
              content: Buffer.from(content, 'utf-8').toString('base64'),
              encoding: 'base64',
            },
          };
        },
      },
    },
  } as unknown as Octokit;
}
