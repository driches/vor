/**
 * Fetches PR metadata, file list (with size info from the Files API), and merges
 * with the parsed diff to produce the final `ChangedFile[]` the agent sees.
 */

import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from '../types.js';
import { GitHubApiError } from '../util/errors.js';
import { fetchPullRequestDiff, type DiffRef } from './diff-fetcher.js';
import { parseUnifiedDiff } from './diff-parser.js';

export interface PRMetadata {
  number: number;
  title: string;
  body: string;
  author: string;
  base_sha: string;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  labels: string[];
  changed_file_count: number;
  additions: number;
  deletions: number;
  draft: boolean;
}

export interface PRContext {
  metadata: PRMetadata;
  files: ChangedFile[];
  diff: string;
}

export async function fetchPRContext(octokit: Octokit, ref: DiffRef): Promise<PRContext> {
  let prData: Awaited<ReturnType<typeof octokit.rest.pulls.get>>['data'];
  try {
    const r = await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
    });
    prData = r.data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new GitHubApiError(
      `Failed to fetch PR ${ref.owner}/${ref.repo}#${ref.pull_number}`,
      status,
      { cause: err },
    );
  }

  const metadata: PRMetadata = {
    number: prData.number,
    title: prData.title,
    body: prData.body ?? '',
    author: prData.user?.login ?? 'unknown',
    base_sha: prData.base.sha,
    head_sha: prData.head.sha,
    base_ref: prData.base.ref,
    head_ref: prData.head.ref,
    labels: prData.labels.map((l) => l.name),
    changed_file_count: prData.changed_files,
    additions: prData.additions,
    deletions: prData.deletions,
    draft: Boolean(prData.draft),
  };

  // Diff (raw text) — fed to the agent and parsed for reviewable_lines.
  const diff = await fetchPullRequestDiff(octokit, ref);
  const filesFromDiff = parseUnifiedDiff(diff);

  // Files API — gives us size, status, and `patch === null` as the canonical
  // binary-file signal.
  const filesByPath = await fetchPRFiles(octokit, ref);
  const files = filesFromDiff.map((f): ChangedFile => {
    const apiFile = filesByPath.get(f.path);
    if (!apiFile) return f;
    return {
      ...f,
      size_bytes: apiFile.changes ?? 0,
      is_binary: f.is_binary || apiFile.patch == null,
    };
  });

  return { metadata, files, diff };
}

async function fetchPRFiles(
  octokit: Octokit,
  ref: DiffRef,
): Promise<Map<string, { changes: number; patch: string | undefined | null }>> {
  const out = new Map<string, { changes: number; patch: string | undefined | null }>();
  let page = 1;
  while (true) {
    const r = await octokit.rest.pulls.listFiles({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: 100,
      page,
    });
    for (const file of r.data) {
      out.set(file.filename, { changes: file.changes, patch: file.patch ?? null });
    }
    if (r.data.length < 100) break;
    page += 1;
  }
  return out;
}
