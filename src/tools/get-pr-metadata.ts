import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';

export function makeGetPrMetadataTool(deps: ToolDeps) {
  return tool(
    'get_pr_metadata',
    'Returns metadata for this PR: title, body, author, base/head SHAs, labels, and totals. ' +
      'Always your FIRST call. Use this to understand author intent before reading any code.',
    {} as Record<string, never>,
    async () => {
      const m = deps.prContext.metadata;
      return jsonResult({
        number: m.number,
        title: m.title,
        body: m.body,
        author: m.author,
        base_ref: m.base_ref,
        head_ref: m.head_ref,
        base_sha: m.base_sha,
        head_sha: m.head_sha,
        labels: m.labels,
        draft: m.draft,
        changed_file_count: m.changed_file_count,
        additions: m.additions,
        deletions: m.deletions,
      });
    },
  );
}

// Suppress unused-import warning when only types are needed at compile time.
void z;
