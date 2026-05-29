import type { ReviewConfig } from '../config/types.js';
import type { PRContext } from '../github/pr-context.js';
import type { ChangedFile } from '../types.js';

export interface AgentPrScope {
  prContext: PRContext;
  unreviewedPaths: string[];
}

/**
 * Build the PR view handed to the LLM. Scanners still receive the full PR;
 * this only prevents the model from spending turns on configured exclusions
 * and oversized files that deterministic scanners can handle independently.
 */
export function scopePrContextForAgent(
  prContext: PRContext,
  exclude: ReviewConfig['exclude'],
): AgentPrScope {
  const kept: ChangedFile[] = [];
  const unreviewedPaths: string[] = [];

  for (const file of prContext.files) {
    if (matchesAnyPattern(file.path, exclude.paths)) {
      unreviewedPaths.push(file.path);
      continue;
    }
    if (file.previous_path && matchesAnyPattern(file.previous_path, exclude.paths)) {
      unreviewedPaths.push(file.path);
      continue;
    }
    const changedLines = file.additions + file.deletions;
    if (changedLines > exclude.max_diff_lines_per_file) {
      unreviewedPaths.push(file.path);
      continue;
    }
    kept.push(file);
  }

  const keptPaths = new Set(kept.map((f) => f.path));
  return {
    prContext: {
      ...prContext,
      files: kept,
      diff: filterDiffByPaths(prContext.diff, keptPaths),
    },
    unreviewedPaths,
  };
}

export function buildAgentScopeNotice(unreviewedPaths: readonly string[]): string {
  if (unreviewedPaths.length === 0) return '';
  const shown = unreviewedPaths
    .slice(0, 30)
    .map((p) => `- ${p}`)
    .join('\n');
  const extra =
    unreviewedPaths.length > 30 ? `\n- ...and ${unreviewedPaths.length - 30} more path(s)` : '';
  return [
    '## Agent scope',
    '',
    'The following path(s) are intentionally outside the LLM review scope due to configured exclusions or per-file diff budget. Deterministic scanners may still inspect them and post findings independently. Do not spend tool calls trying to review these paths; include them in `post_summary.unreviewed_paths` if you mention coverage.',
    '',
    shown + extra,
  ].join('\n');
}

function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

const regexCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        const after = pattern[i + 2];
        if (after === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegexChar(ch);
  }
  out += '$';

  const re = new RegExp(out);
  regexCache.set(pattern, re);
  return re;
}

function escapeRegexChar(ch: string): string {
  return /[\\^$+?.()|{}[\]]/.test(ch) ? `\\${ch}` : ch;
}

function filterDiffByPaths(diff: string, wanted: Set<string>): string {
  if (wanted.size === 0 || diff.length === 0) return '';
  const blocks = diff.split(/(?=^diff --git )/m);
  return blocks
    .filter((block) => {
      const m = block.match(/^diff --git a\/(.+) b\/(.+)$/m);
      if (!m) return false;
      return wanted.has(m[2]!) || wanted.has(m[1]!);
    })
    .join('');
}
