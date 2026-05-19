import { spawn } from 'node:child_process';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { jsonResult, type ToolDeps } from './types.js';

const HARD_RESULT_CAP = 200;
const TIMEOUT_MS = 10_000;

export function makeGrepRepoAtRefTool(deps: ToolDeps) {
  return tool(
    'grep_repo_at_ref',
    'Searches the repo for a regex pattern at HEAD. Use this BEFORE commenting ' +
      '"this is unused" / "we have a helper for this" / "breaks the pattern". ' +
      'Optional path_glob to restrict scope. Runs against the local working tree ' +
      '(checked out at PR HEAD).',
    {
      pattern: z.string().min(1).describe('Regex pattern, ERE syntax (git grep -E).'),
      ref: z
        .enum(['head'])
        .default('head')
        .describe('Only "head" is supported (the checkout reflects PR HEAD).'),
      path_glob: z
        .string()
        .optional()
        .describe('Path glob to restrict the search, e.g., "src/**/*.ts".'),
      max_results: z
        .number()
        .int()
        .positive()
        .max(HARD_RESULT_CAP)
        .default(50)
        .describe('Max matches to return.'),
      case_sensitive: z.boolean().default(true),
    },
    async (args) => {
      const cap = Math.min(args.max_results, HARD_RESULT_CAP);
      try {
        const result = await runGitGrep({
          pattern: args.pattern,
          cwd: deps.workspaceDir,
          caseSensitive: args.case_sensitive,
          pathGlob: args.path_glob,
          maxResults: cap,
        });
        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          matches: [],
          total: 0,
          truncated: false,
          error: (err as Error).message,
        });
      }
    },
  );
}

interface GrepResult {
  matches: Array<{ path: string; line: number; text: string }>;
  total: number;
  truncated: boolean;
}

async function runGitGrep(opts: {
  pattern: string;
  cwd: string;
  caseSensitive: boolean;
  pathGlob?: string;
  maxResults: number;
}): Promise<GrepResult> {
  const args = ['grep', '-n', '-E'];
  if (!opts.caseSensitive) args.push('-i');
  // Limit lines per file is not directly supported; cap globally below.
  args.push('--no-color', '--');
  args.push(opts.pattern);
  if (opts.pathGlob) args.push(opts.pathGlob);

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      reject(new Error(`git grep timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf-8');
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // git grep returns 1 when no matches; that's not an error
      if (code !== 0 && code !== 1) {
        reject(new Error(`git grep exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(parseGrepOutput(stdout, opts.maxResults));
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseGrepOutput(out: string, cap: number): GrepResult {
  const lines = out.split('\n').filter((l) => l.length > 0);
  const matches: GrepResult['matches'] = [];
  for (const line of lines) {
    // Format: "path:line:text"
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({
      path: m[1]!,
      line: Number.parseInt(m[2]!, 10),
      text: m[3]!,
    });
    if (matches.length >= cap) break;
  }
  return {
    matches,
    total: lines.length,
    truncated: lines.length > cap,
  };
}
