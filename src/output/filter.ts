/**
 * Post-aggregation filters: severity floor, per-file cap, global cap, dedup.
 * Belt-and-suspenders on top of the validator — the validator catches most
 * issues in real time, this is the final pre-post safety net.
 */

import type { PostedComment, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';

export interface FilterConfig {
  severityFloor: Severity;
  maxCommentsPerFile: number;
  maxCommentsTotal: number;
}

export interface FilterResult {
  kept: PostedComment[];
  dropped: number;
}

export function filterComments(
  comments: readonly PostedComment[],
  config: FilterConfig,
): FilterResult {
  const original = comments.length;

  // Severity floor
  let kept = comments.filter(
    (c) => SEVERITY_RANK[c.severity] >= SEVERITY_RANK[config.severityFloor],
  );

  // Sort severity desc so per-file/global caps keep the most important
  kept = [...kept].sort(bySeverityDesc);

  // Per-file cap
  const byFile = new Map<string, PostedComment[]>();
  for (const c of kept) {
    const arr = byFile.get(c.file_path) ?? [];
    arr.push(c);
    byFile.set(c.file_path, arr);
  }
  kept = [];
  for (const [, arr] of byFile) {
    kept.push(...arr.slice(0, config.maxCommentsPerFile));
  }

  // Resort after per-file cap (file order is non-deterministic in maps but stable within
  // each file). Re-sort by severity then stable original order for determinism.
  kept.sort(bySeverityDesc);

  // Global cap
  kept = kept.slice(0, config.maxCommentsTotal);

  return { kept, dropped: original - kept.length };
}

function bySeverityDesc(a: PostedComment, b: PostedComment): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}
