import { tool } from './tool-helper.js';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';

const MAX_BYTES_CAP = 200_000;

export function makeGetPrDiffTool(deps: ToolDeps) {
  return tool(
    'get_pr_diff',
    'Returns the unified diff for this PR. Optional `paths` to filter to specific files. ' +
      'Output is capped at max_bytes (default 100k). If truncated, the response includes ' +
      'omitted_paths so you can fetch them individually via read_file_at_ref.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe('Optional list of paths to filter the diff. Defaults to all changed files.'),
      max_bytes: z
        .number()
        .int()
        .positive()
        .max(MAX_BYTES_CAP)
        .default(100_000)
        .describe('Maximum response size in bytes.'),
    },
    async (args) => {
      let diff = deps.prContext.diff;

      if (args.paths && args.paths.length > 0) {
        const wanted = new Set(args.paths);
        diff = filterDiffByPaths(diff, wanted);
      }

      const omitted: string[] = [];
      let truncated = false;
      if (diff.length > args.max_bytes) {
        truncated = true;
        // Find a chunk boundary close to the cap so we don't break mid-hunk
        const cutAt = findChunkBoundary(diff, args.max_bytes);
        const included = diff.slice(0, cutAt);
        diff = included;
        const includedFiles = new Set(extractFilePaths(included));
        for (const file of deps.prContext.files) {
          if (!includedFiles.has(file.path)) omitted.push(file.path);
        }
      }

      return jsonResult({
        diff,
        truncated,
        omitted_paths: omitted,
        total_files: deps.prContext.files.length,
      });
    },
  );
}

function filterDiffByPaths(diff: string, wanted: Set<string>): string {
  const blocks = diff.split(/(?=^diff --git )/m);
  const kept = blocks.filter((block) => {
    const m = block.match(/^diff --git a\/(\S+) b\/(\S+)/m);
    if (!m) return false;
    return wanted.has(m[2]!) || wanted.has(m[1]!);
  });
  return kept.join('');
}

function extractFilePaths(diff: string): string[] {
  const paths: string[] = [];
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    paths.push(m[2]!);
  }
  return paths;
}

function findChunkBoundary(diff: string, maxBytes: number): number {
  const slice = diff.slice(0, maxBytes);
  const lastBoundary = slice.lastIndexOf('\ndiff --git ');
  if (lastBoundary > 0) return lastBoundary + 1;
  // Fall back to last newline
  const lastNl = slice.lastIndexOf('\n');
  return lastNl > 0 ? lastNl : maxBytes;
}
