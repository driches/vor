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
  // `changes`, `patch`. `patch` MUST be populated for text files: fetchPRContext
  // treats `patch == null` as the binary-file signal (`is_binary || patch ==
  // null`), so omitting it marks every locally changed file binary and gates out
  // the non-binary scanners (secrets, debris, eslint/tsc/semgrep). We slice the
  // real per-file hunk out of the unified diff; genuine binaries are still caught
  // by the diff parser's own `is_binary`, which fetchPRContext ORs in.
  const patchesByPath = splitPatchesByFile(opts.diff);
  const fileApi = opts.files.map((f) => ({
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    previous_filename: f.previous_path,
    // Fall back to '' (non-null) when a section can't be matched, so a text file
    // is never misflagged binary; the diff parser remains the binary authority.
    patch: patchesByPath.get(f.path) ?? '',
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
        // Honor pagination: fetchPRFiles loops `page` until a response has
        // fewer than `per_page` items. Returning the full list every call would
        // never terminate that loop on diffs of >= per_page files, hanging the
        // review before scanners/agent run.
        listFiles: async (args?: { per_page?: number; page?: number }) => {
          const perPage = args?.per_page ?? Math.max(fileApi.length, 1);
          const page = args?.page ?? 1;
          const start = (page - 1) * perPage;
          return { data: fileApi.slice(start, start + perPage) };
        },
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

/**
 * Split a unified diff into per-file patches keyed by the file's new path,
 * mirroring GitHub's per-file `patch` field. Sections start at `diff --git`;
 * the new path is taken from the `+++ b/<path>` line when present (handles
 * renames), falling back to the `b/<path>` side of the `diff --git` header.
 */
export function splitPatchesByFile(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diff) return map;

  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) sections.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));

  for (const section of sections) {
    const path = newPathFromSection(section);
    if (path) map.set(path, section);
  }
  return map;
}

function newPathFromSection(section: string): string | null {
  for (const line of section.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target === '/dev/null') return null; // deletion — no new path
      return target.startsWith('b/') ? target.slice(2) : target;
    }
  }
  // No `+++` line (e.g. a pure-binary or mode-only change): use the header.
  const header = section.split('\n', 1)[0] ?? '';
  const m = header.match(/ b\/(.+)$/);
  return m ? m[1]! : null;
}
