/**
 * Per-run state carried across tool calls in a single agent loop.
 *
 * v0.3.0 — tracks which file-line ranges the agent has actually read via
 * `read_file_at_ref`. The validator consults this before accepting any
 * `post_inline_comment` with severity ≥ Important: Sonnet must have looked
 * at the bytes itself, even if a worker already confirmed the finding. This
 * is the load-bearing safety mechanism that lets us trust worker output for
 * exploration without trusting it for final judgment.
 */

export interface RunContext {
  /**
   * Map from file path → list of inclusive `[start, end]` line ranges Sonnet
   * has read at HEAD this run. Ranges are appended, not merged — overlap is
   * fine; the lookup walks the list.
   */
  readRanges: Map<string, Array<[number, number]>>;
}

export function createRunContext(): RunContext {
  return { readRanges: new Map() };
}

/**
 * Record a `read_file_at_ref` success on HEAD. Reads against the BASE side
 * are NOT recorded — verification of a finding posted on HEAD has to be a
 * HEAD read; a BASE read tells you what was there before, not what's there
 * now.
 */
export function recordHeadRead(
  ctx: RunContext,
  path: string,
  startLine: number,
  endLine: number,
): void {
  if (endLine < startLine) return;
  let ranges = ctx.readRanges.get(path);
  if (ranges === undefined) {
    ranges = [];
    ctx.readRanges.set(path, ranges);
  }
  ranges.push([startLine, endLine]);
}

/** True if `line` falls inside any recorded read range for `path`. */
export function hasReadRange(ctx: RunContext, path: string, line: number): boolean {
  const ranges = ctx.readRanges.get(path);
  if (ranges === undefined) return false;
  return ranges.some(([s, e]) => line >= s && line <= e);
}
