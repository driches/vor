import { tool } from './tool-helper.js';
import { formatRanges } from '../github/reviewable-lines.js';
import { jsonResult, type ToolDeps } from './types.js';

export function makeListChangedFilesTool(deps: ToolDeps) {
  return tool(
    'list_changed_files',
    'Returns the authoritative list of files changed in this PR. For each file: ' +
      'path, status, additions/deletions, language, is_generated, is_binary, and ' +
      'reviewable_line_ranges (the ONLY lines you may post inline comments on). ' +
      'Call this BEFORE attempting any post_inline_comment.',
    {} as Record<string, never>,
    async () => {
      const out = deps.prContext.files.map((f) => ({
        path: f.path,
        ...(f.previous_path ? { previous_path: f.previous_path } : {}),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        language: f.language,
        is_generated: f.is_generated,
        is_binary: f.is_binary,
        reviewable_line_ranges: f.reviewable_lines,
        reviewable_line_ranges_formatted: formatRanges(f.reviewable_lines),
      }));
      return jsonResult(out);
    },
  );
}
