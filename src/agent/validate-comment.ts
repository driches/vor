/**
 * Pure validator for inline comments. THE anti-hallucination choke point.
 *
 * Every `post_inline_comment` tool call runs through this BEFORE being queued.
 * On rejection, returns a structured `{ ok: false, reason, hint }` so the agent
 * can self-correct rather than silently fail.
 */

import { formatRanges, isLineReviewable } from '../github/reviewable-lines.js';
import type { Category, ChangedFile, Confidence, PostedComment, Severity, Side } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { hasReadRange, type RunContext } from './run-context.js';

export interface PostInlineCommentInput {
  severity: Severity;
  file_path: string;
  line: number;
  start_line?: number;
  side: Side;
  category: Category;
  title: string;
  why_it_matters: string;
  suggestion?: string;
  confidence: Confidence;
}

export interface ValidationContext {
  /** All changed files, keyed by path. */
  changedFiles: Map<string, ChangedFile>;
  /** Comments already accepted in this run, for dedup. */
  postedComments: readonly PostedComment[];
  /** Severity below this is auto-rejected. */
  severityFloor: Severity;
  /** Hard cap on title.length + why_it_matters.length. */
  maxBodyChars: number;
  /**
   * Per-run state tracking which file-line ranges the agent has actually
   * read via `read_file_at_ref`. Used to enforce "Sonnet must read the
   * bytes" before posting a critical/important finding — the verification
   * discipline that lets us trust workers for exploration without trusting
   * them for final judgment.
   */
  runContext?: RunContext;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string; hint: string };

export function validateInlineComment(
  input: PostInlineCommentInput,
  ctx: ValidationContext,
): ValidationResult {
  // 1. Path must be in the PR
  const file = ctx.changedFiles.get(input.file_path);
  if (!file) {
    const nearest = nearestPath(input.file_path, [...ctx.changedFiles.keys()]);
    const hint = nearest
      ? `Closest changed file: '${nearest}'. Call list_changed_files to see all reviewable paths.`
      : `No changed files match. Call list_changed_files to see what's in this PR.`;
    return {
      ok: false,
      reason: `file_path '${input.file_path}' is not in this PR`,
      hint,
    };
  }

  // 2. Binary / generated files cannot receive comments
  if (file.is_binary) {
    return {
      ok: false,
      reason: `'${file.path}' is a binary file`,
      hint: `Use skip_file({ file_path: '${file.path}', reason: 'out-of-scope' }) instead.`,
    };
  }
  if (file.is_generated) {
    return {
      ok: false,
      reason: `'${file.path}' is a generated file`,
      hint: `Use skip_file({ file_path: '${file.path}', reason: 'generated' }) instead.`,
    };
  }

  // 3. Line must be in reviewable ranges
  if (!isLineReviewable(input.line, file.reviewable_lines)) {
    const ranges = formatRanges(file.reviewable_lines);
    return {
      ok: false,
      reason: `line ${input.line} of '${file.path}' is not in the diff`,
      hint: ranges
        ? `Reviewable line ranges for '${file.path}': ${ranges}.`
        : `'${file.path}' has no reviewable lines (no added or context lines).`,
    };
  }

  // 4. start_line must be < line
  if (input.start_line !== undefined && input.start_line >= input.line) {
    return {
      ok: false,
      reason: `start_line (${input.start_line}) must be less than line (${input.line})`,
      hint: 'Swap them, or omit start_line for a single-line comment.',
    };
  }

  // 5. start_line must also be in reviewable range
  if (
    input.start_line !== undefined &&
    !isLineReviewable(input.start_line, file.reviewable_lines)
  ) {
    return {
      ok: false,
      reason: `start_line ${input.start_line} of '${file.path}' is not in the diff`,
      hint: `Reviewable line ranges for '${file.path}': ${formatRanges(file.reviewable_lines)}.`,
    };
  }

  // 6. Suggestion must differ from existing line text
  if (input.suggestion !== undefined) {
    const existing = file.head_line_text.get(input.line) ?? '';
    if (normalizeForCompare(input.suggestion) === normalizeForCompare(existing)) {
      return {
        ok: false,
        reason: 'suggestion is identical to the current line content',
        hint: 'Either drop the suggestion (and lower severity) or propose an actual change.',
      };
    }
  }

  // 7. Severity floor
  if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[ctx.severityFloor]) {
    return {
      ok: false,
      reason: `severity '${input.severity}' is below the configured floor '${ctx.severityFloor}'`,
      hint: `Either raise severity (only if genuinely warranted) or skip this finding.`,
    };
  }

  // 8. Body length cap
  const bodyLen = input.title.length + input.why_it_matters.length;
  if (bodyLen > ctx.maxBodyChars) {
    return {
      ok: false,
      reason: `body too long (${bodyLen} > ${ctx.maxBodyChars} chars)`,
      hint: 'Be concise. Headline + 1-3 sentences of why is enough.',
    };
  }

  // 9. Dedup — same (file, line, normalized title) already posted
  const dup = ctx.postedComments.find(
    (c) =>
      c.file_path === input.file_path &&
      c.line === input.line &&
      normalizeForCompare(c.title) === normalizeForCompare(input.title),
  );
  if (dup) {
    return {
      ok: false,
      reason: 'duplicate of an already-posted comment',
      hint: `You already commented on '${input.file_path}':${input.line} with this title.`,
    };
  }

  // 10. Read-before-post: for severity ≥ Important, the agent must have
  //     called read_file_at_ref on the target line at HEAD this run. Worker
  //     output does NOT count — the model posting the finding must look at
  //     the bytes itself. Only enforced when a runContext is supplied;
  //     legacy callers (tests, dry-run code paths) that omit runContext are
  //     unaffected. For multi-line comments we check BOTH endpoints — a
  //     partial read of just the end line is not enough to verify a range
  //     claim, otherwise the rule would let `start_line=10, line=200`
  //     through after only reading line 200.
  //
  //     Known gap (intentional): we only check endpoints, not every line in
  //     the [start_line, line] interval. For `start_line=10, line=200`, the
  //     check passes if 1-10 and 195-200 were read in two separate calls
  //     even though 11-194 was never seen. Full-interval coverage would
  //     require either (a) collapsing overlapping ranges (expensive over a
  //     long run) or (b) forcing a single read that spans the whole
  //     comment, which over-constrains the agent for legitimate wide-range
  //     comments. The endpoint check catches the common "worker said
  //     something, here's my comment with arbitrary range" failure mode
  //     while keeping the gate cheap. If wider coverage becomes important,
  //     promote to full-interval; the function signature can stay.
  if (
    ctx.runContext !== undefined &&
    (input.severity === 'critical' || input.severity === 'important')
  ) {
    const linesToCheck: number[] = [input.line];
    if (input.start_line !== undefined) linesToCheck.unshift(input.start_line);
    const unread = linesToCheck.find(
      (line) => !hasReadRange(ctx.runContext!, input.file_path, line),
    );
    if (unread !== undefined) {
      const span =
        input.start_line !== undefined
          ? `lines ${input.start_line}-${input.line}`
          : `line ${input.line}`;
      const win = 10;
      const hintStart = Math.max(1, (input.start_line ?? input.line) - win);
      const hintEnd = input.line + win;
      return {
        ok: false,
        reason: `you have not called read_file_at_ref on '${input.file_path}' covering ${span} this run (unread: line ${unread})`,
        hint:
          `Before posting a ${input.severity} finding you must read the target ${span} ` +
          `yourself (worker output does NOT count). Call read_file_at_ref({ path: '${input.file_path}', ref: 'head', start_line: ${hintStart}, end_line: ${hintEnd} }) and try again.`,
      };
    }
  }

  return { ok: true };
}

function normalizeForCompare(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Find the path in `candidates` closest to `target` by Levenshtein distance.
 * Returns null if there are no candidates.
 */
export function nearestPath(target: string, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestDist = levenshtein(target, best);
  for (let i = 1; i < candidates.length; i++) {
    const d = levenshtein(target, candidates[i]!);
    if (d < bestDist) {
      bestDist = d;
      best = candidates[i]!;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}
