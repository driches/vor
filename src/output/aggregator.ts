/**
 * In-memory ReviewDraft built up as the agent calls tools.
 * Posted in a single octokit.pulls.createReview at the end of the run.
 */

import type { PostedComment, ReviewDraft, SkippedFile, SummaryInput } from '../types.js';

export class ReviewAggregator {
  private comments: PostedComment[] = [];
  private skipped: SkippedFile[] = [];
  private summary: SummaryInput | null = null;

  addComment(c: PostedComment): void {
    this.comments.push(c);
  }

  addSkipped(s: SkippedFile): void {
    this.skipped.push(s);
  }

  setSummary(s: SummaryInput): void {
    if (this.summary) {
      throw new Error('summary already set — post_summary may only be called once');
    }
    this.summary = s;
  }

  hasSummary(): boolean {
    return this.summary !== null;
  }

  get acceptedComments(): readonly PostedComment[] {
    return this.comments;
  }

  hasCriticalOrImportant(): boolean {
    return this.comments.some((c) => c.severity === 'critical' || c.severity === 'important');
  }

  /** Snapshot the current draft (useful for error-path partial posts). */
  snapshot(): ReviewDraft {
    return {
      comments: [...this.comments],
      skipped: [...this.skipped],
      ...(this.summary ? { summary: this.summary } : {}),
    };
  }
}
