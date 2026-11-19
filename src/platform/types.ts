import type { ReviewEvent, PostedComment } from '../types.js';
import type { PriorReviewThread } from './prior-review-threads.js';

export type PlatformId = string;

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
  files: import('../types.js').ChangedFile[];
  diff: string;
}

export interface FileReadRef {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export interface RepoFileReader {
  read(ref: FileReadRef): Promise<string | null>;
  readRange(
    ref: FileReadRef,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; total_lines: number; returned_range: [number, number] } | null>;
  readBinary(ref: FileReadRef): Promise<Buffer | null>;
}

export interface PlatformReviewInput {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: PostedComment[];
}

export interface PlatformPostResult {
  review_id?: number;
  post_id?: string;
  comment_count: number;
}

export interface ReviewPlatform {
  id: PlatformId;
  displayName: string;
  owner: string;
  repo: string;
  pull_number: number;
  repoLabel: string;
  authSecrets: readonly string[];
  fileReader: RepoFileReader;
  fetchPRContext(): Promise<PRContext>;
  fetchPriorReviewThreads(context: PRContext): Promise<PriorReviewThread[]>;
  supersedePriorReviews(context: PRContext): Promise<number>;
  postReview(input: PlatformReviewInput): Promise<PlatformPostResult>;
}
