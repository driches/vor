/**
 * Normalized finding used by the golden-dataset comparison harness.
 *
 * One shape so we can compare apples to apples regardless of source:
 *   - "ours" comes from PostedComment (already structured)
 *   - "codex" comes from GitHub PR review JSON parsed by normalize-codex.ts
 *   - "human" comes from manual ground-truth labels (future)
 *
 * Severity and category may be 'unknown' for bot output that doesn't tag them
 * (Codex puts severity in the comment body as Markdown — see normalize-codex.ts).
 */

import type { Category, PostedComment, Severity } from '../types.js';

export type FindingSource = 'ours' | 'codex' | 'human';

export interface NormalizedFinding {
  /** Where this finding came from. */
  source: FindingSource;
  /** File path the finding applies to. */
  file_path: string;
  /** Line number on the relevant side of the diff (HEAD for our findings). */
  line: number;
  /**
   * Identifier of the hunk containing this finding, used as the primary match
   * key in compare.ts. Format: `${file_path}#hunk_${index}`. Computed by
   * compare.ts from diff.patch — not stored upstream.
   */
  hunk_id?: string;
  /** Severity if known, else 'unknown'. */
  severity: Severity | 'unknown';
  /** Category if known, else 'unknown'. */
  category: Category | 'unknown';
  /** Short title or first-line summary (8–120 chars when from our schema). */
  title?: string;
  /** Full comment body / `why_it_matters` / Markdown explanation. */
  body: string;
  /** Original object preserved for traceability. */
  raw: unknown;
}

/**
 * Convert a PostedComment (our internal accepted-comment shape) into the
 * normalized form used by the comparison harness. PostedComment is already
 * structured — this is a pure adapter, no inference required.
 */
export function fromPostedComment(c: PostedComment): NormalizedFinding {
  return {
    source: 'ours',
    file_path: c.file_path,
    line: c.line,
    severity: c.severity,
    category: c.category,
    title: c.title,
    body: c.why_it_matters,
    raw: c,
  };
}
