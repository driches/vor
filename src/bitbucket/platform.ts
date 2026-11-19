import type { ChangedFile } from '../types.js';
import { renderCommentBody } from '../output/comment-body.js';
import { detectLanguage, isGeneratedPath, parseUnifiedDiff } from '../platform/diff-parser.js';
import { isRejectionReply, type PriorReviewThread } from '../platform/prior-review-threads.js';
import { AGENT_REVIEW_MARKER } from '../platform/review-marker.js';
import type {
  FileReadRef,
  PRContext,
  PRMetadata,
  RepoFileReader,
  ReviewPlatform,
} from '../platform/types.js';
import { BitbucketApiError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import {
  BitbucketClient,
  type BitbucketComment,
  type BitbucketDiffStat,
  type BitbucketPullRequest,
} from './client.js';

export interface BitbucketPlatformInput {
  workspace: string;
  repoSlug: string;
  pullRequestId: number;
  email: string;
  apiToken: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createBitbucketPlatform(input: BitbucketPlatformInput): ReviewPlatform {
  const client = new BitbucketClient({
    workspace: input.workspace,
    repoSlug: input.repoSlug,
    email: input.email,
    apiToken: input.apiToken,
    ...(input.apiBaseUrl !== undefined ? { apiBaseUrl: input.apiBaseUrl } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });
  const fileReader = new BitbucketFileReader(client);
  let pendingStickyCleanup:
    | { expectedHeadSha: string; comments: readonly BitbucketComment[] }
    | undefined;

  return {
    id: 'bitbucket',
    displayName: 'Bitbucket',
    owner: input.workspace,
    repo: input.repoSlug,
    pull_number: input.pullRequestId,
    repoLabel: `${input.workspace}/${input.repoSlug}`,
    authSecrets: [input.apiToken],
    fileReader,
    fetchPRContext: async () => {
      const [pr, diff, diffstat] = await Promise.all([
        client.getPullRequest(input.pullRequestId),
        client.getPullRequestDiff(input.pullRequestId),
        client.listDiffStat(input.pullRequestId),
      ]);
      return buildPRContext(pr, diff, diffstat);
    },
    fetchPriorReviewThreads: async () => {
      const comments = await client.listComments(input.pullRequestId);
      return commentsToPriorThreads(comments);
    },
    supersedePriorReviews: async (context) => {
      const comments = await client.listComments(input.pullRequestId);
      await assertCurrentHead(client, input.pullRequestId, context.metadata.head_sha);
      // Bitbucket creates a review as multiple comment requests. Stage cleanup
      // until every replacement comment exists so a partial post cannot erase
      // the only complete prior review.
      pendingStickyCleanup = {
        expectedHeadSha: context.metadata.head_sha,
        comments,
      };
      return 0;
    },
    postReview: async (review) => {
      // Platform instances are exported and can be reused after a failed run.
      // Consume the staged transaction up front so a later non-sticky post
      // cannot inherit cleanup that belonged to this attempt.
      const stickyCleanup = pendingStickyCleanup;
      pendingStickyCleanup = undefined;
      await assertCurrentHead(client, input.pullRequestId, review.commit_id);
      const summary = await client.createComment(input.pullRequestId, {
        body: `${AGENT_REVIEW_MARKER}\n\n${review.body}`,
      });

      for (const comment of review.comments) {
        await client.createComment(input.pullRequestId, {
          body: `${AGENT_REVIEW_MARKER}\n\n${renderCommentBody(comment)}`,
          inline: {
            path: comment.file_path,
            line: comment.line,
            side: comment.side,
            ...(comment.start_line !== undefined ? { startLine: comment.start_line } : {}),
          },
        });
      }

      // A source push during the sequential comment requests leaves the new
      // partial artifacts visible, but must not also destroy the prior review.
      await assertCurrentHead(client, input.pullRequestId, review.commit_id);
      if (stickyCleanup !== undefined) {
        if (stickyCleanup.expectedHeadSha !== review.commit_id) {
          throw new BitbucketApiError(
            `Bitbucket sticky cleanup was prepared for ${stickyCleanup.expectedHeadSha}, ` +
              `not ${review.commit_id}`,
          );
        }
        const superseded = await applyStickyCleanup(
          client,
          input.pullRequestId,
          stickyCleanup.comments,
        );
        if (superseded > 0) {
          await logger.info(`Superseded ${superseded} prior agent review artifact(s).`);
        }
      }

      try {
        if (review.event === 'APPROVE') {
          await client.approve(input.pullRequestId);
        } else if (review.event === 'REQUEST_CHANGES') {
          await client.requestChanges(input.pullRequestId);
        }
      } catch (err) {
        await logger.warn(
          `Bitbucket review state update (${review.event}) failed: ${(err as Error).message}`,
        );
      }

      return {
        post_id: String(summary.id),
        comment_count: review.comments.length,
      };
    },
  };
}

async function applyStickyCleanup(
  client: BitbucketClient,
  prId: number,
  comments: readonly BitbucketComment[],
): Promise<number> {
  let resolved = 0;
  for (const comment of comments) {
    if (!isVorInlineRoot(comment)) continue;
    if (comment.deleted || comment.pending || comment.resolution != null) continue;
    try {
      await client.resolveComment(prId, comment.id);
      resolved += 1;
    } catch (err) {
      if (err instanceof BitbucketApiError && err.status === 409) continue;
      await logger.warn(
        `Failed to resolve prior Bitbucket comment ${comment.id}: ${(err as Error).message}`,
      );
    }
  }
  if (comments.some((comment) => isVorComment(comment) && comment.parent?.id === undefined)) {
    await clearPriorReviewState(client, prId);
  }
  return resolved;
}

async function assertCurrentHead(
  client: BitbucketClient,
  prId: number,
  expectedCommitId: string,
): Promise<void> {
  const pr = await client.getPullRequest(prId);
  const actualCommitId = pr.source?.commit?.hash;
  if (actualCommitId === expectedCommitId) return;

  throw new BitbucketApiError(
    `Bitbucket PR ${prId} head changed during review (expected ${expectedCommitId}, ` +
      `found ${actualCommitId ?? 'missing'}); refusing to write stale review results`,
  );
}

class BitbucketFileReader implements RepoFileReader {
  private cache = new Map<string, string>();
  private binaryCache = new Map<string, Buffer>();

  constructor(
    private readonly client: BitbucketClient,
    private readonly maxEntries = 100,
  ) {}

  async read(ref: FileReadRef): Promise<string | null> {
    const key = `${ref.ref}::${ref.path}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const bytes = await this.client.readSource(ref.ref, ref.path);
    if (bytes === null) return null;
    const content = bytes.toString('utf-8');
    this.set(this.cache, key, content);
    return content;
  }

  async readRange(
    ref: FileReadRef,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; total_lines: number; returned_range: [number, number] } | null> {
    const full = await this.read(ref);
    if (full == null) return null;
    const lines = full.split('\n');
    const total = lines.length;
    const start = Math.max(1, startLine);
    const end = Math.min(total, endLine);
    return {
      content: lines.slice(start - 1, end).join('\n'),
      total_lines: total,
      returned_range: [start, end],
    };
  }

  async readBinary(ref: FileReadRef): Promise<Buffer | null> {
    const key = `${ref.ref}::${ref.path}`;
    const cached = this.binaryCache.get(key);
    if (cached !== undefined) {
      this.binaryCache.delete(key);
      this.binaryCache.set(key, cached);
      return cached;
    }
    const bytes = await this.client.readSource(ref.ref, ref.path);
    if (bytes === null) return null;
    this.set(this.binaryCache, key, bytes);
    return bytes;
  }

  private set<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= this.maxEntries) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, value);
  }
}

function buildPRContext(
  pr: BitbucketPullRequest,
  diff: string,
  diffstat: readonly BitbucketDiffStat[],
): PRContext {
  const baseSha = pr.destination?.commit?.hash;
  const headSha = pr.source?.commit?.hash;
  if (!baseSha || !headSha) {
    throw new BitbucketApiError(`Bitbucket PR ${pr.id} is missing source or destination commit`);
  }

  const statByPath = new Map<string, BitbucketDiffStat>();
  for (const stat of diffstat) {
    const path = stat.new?.path ?? stat.old?.path;
    if (path) statByPath.set(path, stat);
  }

  const parsedFiles = parseUnifiedDiff(diff);
  const seen = new Set<string>();
  const files = parsedFiles.map((file) => {
    seen.add(file.path);
    const stat = statByPath.get(file.path) ?? statByPath.get(file.previous_path ?? '');
    return mergeDiffStat(file, stat);
  });

  for (const stat of diffstat) {
    const path = stat.new?.path ?? stat.old?.path;
    if (!path || seen.has(path)) continue;
    files.push(diffStatOnlyFile(path, stat));
  }

  const additions = diffstat.reduce((sum, stat) => sum + (stat.lines_added ?? 0), 0);
  const deletions = diffstat.reduce((sum, stat) => sum + (stat.lines_removed ?? 0), 0);
  const metadata: PRMetadata = {
    number: pr.id,
    title: pr.title,
    body: pr.description ?? pr.summary?.raw ?? '',
    author: pr.author?.nickname ?? pr.author?.display_name ?? pr.author?.account_id ?? 'unknown',
    base_sha: baseSha,
    head_sha: headSha,
    base_ref: pr.destination?.branch?.name ?? '',
    head_ref: pr.source?.branch?.name ?? '',
    labels: [],
    changed_file_count: files.length,
    additions,
    deletions,
    draft: Boolean(pr.draft),
  };
  return { metadata, files, diff };
}

function mergeDiffStat(file: ChangedFile, stat: BitbucketDiffStat | undefined): ChangedFile {
  if (stat === undefined) return file;
  return {
    ...file,
    status: statusFromDiffStat(stat, file),
    additions: stat.lines_added ?? file.additions,
    deletions: stat.lines_removed ?? file.deletions,
    size_bytes: (stat.lines_added ?? 0) + (stat.lines_removed ?? 0),
  };
}

function diffStatOnlyFile(path: string, stat: BitbucketDiffStat): ChangedFile {
  return {
    path,
    ...(stat.old?.path && stat.old.path !== path ? { previous_path: stat.old.path } : {}),
    status: statusFromDiffStat(stat),
    additions: stat.lines_added ?? 0,
    deletions: stat.lines_removed ?? 0,
    reviewable_lines: [],
    added_lines: new Set<number>(),
    language: detectLanguage(path),
    is_generated: isGeneratedPath(path),
    is_binary: true,
    size_bytes: (stat.lines_added ?? 0) + (stat.lines_removed ?? 0),
    head_line_text: new Map<number, string>(),
  };
}

function statusFromDiffStat(
  stat: BitbucketDiffStat,
  fallback?: Pick<ChangedFile, 'status'>,
): ChangedFile['status'] {
  const status = stat.status?.toLowerCase();
  if (status === 'added') return 'added';
  if (status === 'removed' || status === 'deleted') return 'removed';
  if (status === 'renamed') return 'renamed';
  if (stat.old?.path && stat.new?.path && stat.old.path !== stat.new.path) return 'renamed';
  return fallback?.status ?? 'modified';
}

function commentsToPriorThreads(comments: readonly BitbucketComment[]): PriorReviewThread[] {
  const byParent = new Map<number, BitbucketComment[]>();
  for (const comment of comments) {
    const parentId = comment.parent?.id;
    if (parentId === undefined) continue;
    const replies = byParent.get(parentId) ?? [];
    replies.push(comment);
    byParent.set(parentId, replies);
  }

  const threads: PriorReviewThread[] = [];
  for (const comment of comments) {
    if (!isVorInlineRoot(comment) || comment.deleted || comment.pending) continue;
    const replies = (byParent.get(comment.id) ?? []).sort((a, b) => a.id - b.id);
    const replySummaries = replies.map((reply) => ({
      author:
        reply.user?.nickname ?? reply.user?.display_name ?? reply.user?.account_id ?? 'unknown',
      excerpt: excerpt(reply.content?.raw ?? ''),
    }));
    const line = comment.inline?.to ?? comment.inline?.from ?? null;
    threads.push({
      file_path: comment.inline.path,
      line,
      outdated: line === null,
      finding_excerpt: excerpt(stripMarker(comment.content?.raw ?? '')),
      // Sticky cleanup resolves unresolved Bitbucket threads before the new
      // run posts. Mark them as dismissable so the shared prompt filter does
      // not suppress a still-valid finding whose old thread is about to lose
      // its active backing.
      from_dismissable_review: comment.resolution == null,
      already_dismissed: comment.resolution != null,
      has_pushback: replies.some((reply) => isRejectionReply(reply.content?.raw ?? '')),
      replies: replySummaries,
    });
  }
  return threads;
}

function isVorComment(comment: BitbucketComment): boolean {
  return Boolean(comment.content?.raw?.includes(AGENT_REVIEW_MARKER));
}

type BitbucketInlineRoot = BitbucketComment & {
  inline: NonNullable<BitbucketComment['inline']> & { path: string };
};

function isVorInlineRoot(comment: BitbucketComment): comment is BitbucketInlineRoot {
  return (
    isVorComment(comment) &&
    comment.parent?.id === undefined &&
    typeof comment.inline?.path === 'string' &&
    comment.inline.path.length > 0
  );
}

async function clearPriorReviewState(client: BitbucketClient, prId: number): Promise<void> {
  const operations = [
    { label: 'approval', run: () => client.unapprove(prId) },
    { label: 'change request', run: () => client.removeChangeRequest(prId) },
  ];
  for (const operation of operations) {
    try {
      await operation.run();
    } catch (err) {
      if (err instanceof BitbucketApiError && (err.status === 400 || err.status === 404)) continue;
      await logger.warn(
        `Failed to clear prior Bitbucket ${operation.label}: ${(err as Error).message}`,
      );
    }
  }
}

function stripMarker(body: string): string {
  return body.replace(AGENT_REVIEW_MARKER, '').trim();
}

function excerpt(body: string, max = 200): string {
  const line =
    stripMarker(body)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('>')) ?? '';
  const cleaned = line
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^[>#\s-]+/, '')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}
