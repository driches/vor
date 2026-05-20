/**
 * Pre-aggregator validator for scanner findings.
 *
 * Scanners are trusted in a way the agent isn't — they don't hallucinate file
 * paths or invent line numbers. This validator exists only to keep the
 * GitHub API from rejecting the eventual review, so it checks:
 *
 *   1. The file referenced by the finding is in the PR.
 *   2. The file is not binary and not generated.
 *   3. The `line` falls in `file.reviewable_lines`.
 *   4. If `start_line` is set, it is reviewable AND strictly less than `line`.
 *
 * Severity floors, body-length caps, suggestion-vs-existing-line checks, and
 * dedup all live in the runner (Task 7) — not here. A `false` result returns
 * a `reason` string suitable for surfacing in the run log.
 */
import { isLineReviewable } from '../github/reviewable-lines.js';
import type { ChangedFile } from '../types.js';
import type { ScanFinding } from './types.js';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface ScannerValidationContext {
  /** All changed files in the PR, keyed by path. */
  changedFiles: Map<string, ChangedFile>;
}

export function validateScanFinding(
  finding: ScanFinding,
  ctx: ScannerValidationContext,
): ValidationResult {
  const file = ctx.changedFiles.get(finding.file_path);
  if (!file) {
    return {
      ok: false,
      reason: `file_path '${finding.file_path}' is not in this PR`,
    };
  }

  if (file.is_binary) {
    return { ok: false, reason: `'${file.path}' is a binary file` };
  }
  if (file.is_generated) {
    return { ok: false, reason: `'${file.path}' is a generated file` };
  }

  if (!isLineReviewable(finding.line, file.reviewable_lines)) {
    return {
      ok: false,
      reason: `line ${finding.line} of '${file.path}' is not in the diff`,
    };
  }

  if (finding.start_line !== undefined) {
    if (finding.start_line >= finding.line) {
      return {
        ok: false,
        reason: `start_line (${finding.start_line}) must be less than line (${finding.line})`,
      };
    }
    if (!isLineReviewable(finding.start_line, file.reviewable_lines)) {
      return {
        ok: false,
        reason: `start_line ${finding.start_line} of '${file.path}' is not in the diff`,
      };
    }
  }

  return { ok: true };
}
