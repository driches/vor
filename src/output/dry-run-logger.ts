/**
 * Pretty-prints what would be posted when running in dry-run mode (no actual
 * GitHub API call). Output goes to the action logs for human inspection.
 */

import type { PostedComment, ReviewDraft, ReviewEvent } from '../types.js';
import { renderCommentBody } from '../github/review-poster.js';
import { logger } from '../util/logger.js';

export interface DryRunInput {
  event: ReviewEvent;
  body: string;
  comments: readonly PostedComment[];
  draft: ReviewDraft;
}

export async function logDryRunReview(input: DryRunInput): Promise<void> {
  await logger.info('================ DRY RUN ================');
  await logger.info(`Event: ${input.event}`);
  await logger.info(`Comments: ${input.comments.length}`);
  await logger.info(`Skipped files: ${input.draft.skipped.length}`);
  await logger.info('---- SUMMARY BODY ----');
  await logger.info(input.body);

  for (const c of input.comments) {
    await logger.info(`---- ${c.file_path}:${c.line} [${c.severity.toUpperCase()}] ----`);
    await logger.info(renderCommentBody(c));
  }

  await logger.info('=========================================');
}
