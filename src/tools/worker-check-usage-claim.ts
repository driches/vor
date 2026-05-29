/**
 * worker_check_usage_claim — Sonnet delegates a verification claim to a
 * cheap Haiku worker.
 *
 * Sonnet's most expensive recurring pattern is verification: "is `foo`
 * actually unused? Let me grep, then read 2-3 files, then decide." That's
 * typically 3-5 Sonnet turns per finding. This tool collapses the grep +
 * read steps into a single Haiku call. The worker returns a structured
 * verdict ('confirmed' | 'refuted' | 'inconclusive') with evidence; Sonnet
 * treats it as a hint and (for critical/important findings) still calls
 * read_file_at_ref itself before posting — the validator rejects otherwise.
 *
 * Pre-fetching pattern: the parent (this handler) runs grep_repo_at_ref and
 * read_file_at_ref-equivalent calls, then hands the resulting text to the
 * worker. The worker doesn't get its own tool loop because (a) a worker with
 * tools re-creates the agentic surface we're localizing Sonnet to handle,
 * and (b) Haiku at 28% recall as a top-level agent is a known failure mode.
 * Workers are dumb fact-extractors.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { tool } from './tool-helper.js';
import { BudgetError } from '../util/errors.js';
import { jsonResult, type ToolDeps } from './types.js';

const GREP_RESULT_CAP = 30;
const GREP_TIMEOUT_MS = 10_000;
const READ_FILE_LINES_PER_CALL = 200;
const TOP_FILES_TO_READ = 3;

const verdictSchema = z.object({
  verdict: z.enum(['confirmed', 'refuted', 'inconclusive']),
  call_sites: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().int().nonnegative(),
        snippet: z.string(),
      }),
    )
    .default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.string().min(1).max(800),
  files_searched: z.array(z.string()).default([]),
});

const WORKER_SYSTEM_PROMPT = `You are a verification worker assisting a senior reviewer.

Your ONLY job is to read the provided search results and file content, then return a JSON verdict on a specific usage claim. You do NOT post comments, you do NOT make judgment calls about code quality, you do NOT propose fixes.

You will receive:
- A symbol name (function / class / variable)
- A claim about it ('unused', 'single_caller', or 'pattern_violation')
- Context — why the senior reviewer wants to know
- Grep results from the repo (file:line:text matches)
- File contents around the top matches

You must return JSON matching this schema EXACTLY (no markdown fences, no prose before or after):

{
  "verdict": "confirmed" | "refuted" | "inconclusive",
  "call_sites": [ { "path": "...", "line": N, "snippet": "..." }, ... ],   // The MOST relevant matches, max 5
  "confidence": "high" | "medium" | "low",
  "evidence": "1-2 sentence explanation citing the evidence you saw",
  "files_searched": ["src/foo.ts", ...]                                    // Paths whose content you inspected
}

Verdict rules:
- 'unused' claim: 'confirmed' if zero non-trivial call sites (tests, comments, the definition itself don't count); 'refuted' if real call sites exist; 'inconclusive' if grep was inconclusive.
- 'single_caller' claim: 'confirmed' if exactly one non-trivial call site; otherwise 'refuted' (multiple) or 'inconclusive'.
- 'pattern_violation' claim: 'confirmed' if the code clearly violates a documented pattern in the searched files; 'refuted' if it follows the pattern; 'inconclusive' if no pattern is documented.

Confidence rules:
- 'high': the evidence is unambiguous (e.g., zero matches for an 'unused' claim, or a clearly-documented opposing pattern).
- 'medium': evidence supports a verdict but there are sources you couldn't inspect (e.g., the symbol is exported and may be used outside the repo).
- 'low': inconclusive grep, partial reads, or unclear pattern. Default to 'low' if unsure — the senior reviewer will re-verify.`;

export function makeWorkerCheckUsageClaimTool(deps: ToolDeps) {
  return tool(
    'worker_check_usage_claim',
    'Delegate verification of a usage claim to a cheap worker (claude-haiku-4-5). ' +
      'Use this during verification (phase 5) instead of doing the grep + read yourself, ' +
      'when you want to check whether a symbol is unused, has a single caller, or ' +
      'violates a documented pattern. Returns a structured verdict + evidence as JSON.\n\n' +
      'IMPORTANT: Worker output is a HINT, not evidence. For findings with severity ' +
      'critical or important you MUST still call read_file_at_ref on the target line ' +
      'range yourself before post_inline_comment — the validator will reject otherwise. ' +
      'For minor/nit findings, the worker output alone is acceptable evidence.',
    {
      symbol: z
        .string()
        .min(1)
        .describe('The symbol being checked (function/class/variable/method name).'),
      claim: z
        .enum(['unused', 'single_caller', 'pattern_violation'])
        .describe('Which property of the symbol you want verified.'),
      path_glob: z
        .string()
        .optional()
        .describe(
          "Optional path glob (git-grep syntax) to scope the search, e.g. 'src/**/*.ts'. Omit to search the whole repo.",
        ),
      context: z
        .string()
        .min(8)
        .max(400)
        .describe(
          'Why you are checking this — gives the worker focus. ' +
            'Example: "PR removes the foo() helper; need to confirm no callers remain."',
        ),
    },
    async (args) => {
      if (deps.worker === undefined) {
        return jsonResult({
          ok: false,
          error: 'worker delegation is not enabled in this run',
          hint: 'Set experimental.worker_delegation.enabled = true in .vor.yml to use this tool.',
        });
      }

      const matches = await runGitGrep(args.symbol, deps.workspaceDir, args.path_glob);

      const topPaths = uniquePaths(matches).slice(0, TOP_FILES_TO_READ);
      const fileSnippets: Array<{ path: string; content: string }> = [];
      for (const path of topPaths) {
        // Center the read window on the FIRST match line for this file.
        // If the symbol's match is at line 350, reading lines 1-200 gives
        // the worker file header content instead of the relevant code —
        // worker returns 'inconclusive' or wrong verdict. Pick a window
        // around the match so the worker sees actual usage.
        const firstMatch = matches.find((m) => m.path === path);
        const matchLine = firstMatch?.line ?? 1;
        const readStart = Math.max(1, matchLine - Math.floor(READ_FILE_LINES_PER_CALL / 2));
        const readEnd = readStart + READ_FILE_LINES_PER_CALL - 1;
        const head = deps.prContext.metadata.head_sha;
        const result = await deps.fileReader.readRange(
          { owner: deps.owner, repo: deps.repo, path, ref: head },
          readStart,
          readEnd,
        );
        if (result !== null) {
          fileSnippets.push({ path, content: result.content });
        }
      }

      const userPrompt = renderUserPrompt({
        symbol: args.symbol,
        claim: args.claim,
        context: args.context,
        matches,
        fileSnippets,
      });

      try {
        const { parsed } = await deps.worker.invoke({
          task: 'check_usage',
          systemPrompt: WORKER_SYSTEM_PROMPT,
          userPrompt,
          maxTokens: 1024,
          responseSchema: verdictSchema,
        });

        return jsonResult({
          ok: true,
          ...parsed,
          // Reminder field — keeps the verification discipline visible even
          // if the agent skims tool output.
          reminder:
            'Worker output is a hint, not evidence. For critical/important findings, call read_file_at_ref on the target lines before posting.',
        });
      } catch (err) {
        // BudgetError must escape so the runner can flip to
        // 'budget_exceeded' and stop the loop. Catching it here would let
        // Sonnet keep making (potentially also over-budget) calls until the
        // turn cap fires. Other worker errors are recoverable — Sonnet
        // should fall back to doing the work itself.
        if (err instanceof BudgetError) throw err;
        return jsonResult({
          ok: false,
          error: `worker call failed: ${(err as Error).message}`,
          hint: 'Fall back to doing the grep + read yourself with grep_repo_at_ref and read_file_at_ref.',
        });
      }
    },
  );
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

function uniquePaths(matches: GrepMatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m.path);
  }
  return out;
}

function renderUserPrompt(args: {
  symbol: string;
  claim: 'unused' | 'single_caller' | 'pattern_violation';
  context: string;
  matches: GrepMatch[];
  fileSnippets: Array<{ path: string; content: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`## Task`);
  lines.push(`Check the claim '${args.claim}' for symbol \`${args.symbol}\`.`);
  lines.push('');
  lines.push(`## Context from senior reviewer`);
  lines.push(args.context);
  lines.push('');
  lines.push(`## Grep results (\`${args.symbol}\` across repo, capped at ${GREP_RESULT_CAP})`);
  if (args.matches.length === 0) {
    lines.push('_No matches._');
  } else {
    for (const m of args.matches) {
      lines.push(`${m.path}:${m.line}: ${m.text}`);
    }
  }
  lines.push('');
  if (args.fileSnippets.length > 0) {
    lines.push(
      `## File content (top ${args.fileSnippets.length} hit files, first ${READ_FILE_LINES_PER_CALL} lines each)`,
    );
    for (const snip of args.fileSnippets) {
      lines.push(`### ${snip.path}`);
      lines.push('```');
      lines.push(snip.content);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('## Required output');
  lines.push(
    'Return ONLY the JSON verdict described in your instructions. No prose, no markdown fence.',
  );
  return lines.join('\n');
}

async function runGitGrep(pattern: string, cwd: string, pathGlob?: string): Promise<GrepMatch[]> {
  const args = ['grep', '-n', '-E', '--no-color', '--', pattern];
  if (pathGlob !== undefined) args.push(pathGlob);

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      // Reject on timeout instead of returning []. An empty match set
      // would be indistinguishable from a real "no callers found" result,
      // which the worker could convert into a confident-wrong 'confirmed'
      // verdict for an 'unused' claim. Throwing lets the worker tool's
      // outer catch produce an `ok: false, error: ...` tool_result so
      // Sonnet knows to fall back to grep_repo_at_ref + read_file_at_ref.
      reject(
        new Error(
          `git grep timed out after ${GREP_TIMEOUT_MS}ms — verdict would be inconclusive, falling back`,
        ),
      );
    }, GREP_TIMEOUT_MS);

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
      // git grep exits 0 = matches, 1 = no matches (not an error), anything
      // else = real error (bad regex, missing pathspec, repo not found).
      // The pre-v0.3.1 code resolved [] on every close code, so a misconfig
      // (e.g. bad workspaceDir or invalid regex) silently became "no
      // matches", which the worker would interpret as "symbol is unused"
      // and return a confident-wrong verdict. Reject instead so the
      // caller surfaces the error.
      if (code !== 0 && code !== 1) {
        reject(new Error(`git grep exited ${code}: ${stderr.trim()}`));
        return;
      }
      const matches = parseGrepOutput(stdout);
      resolve(matches.slice(0, GREP_RESULT_CAP));
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseGrepOutput(out: string): GrepMatch[] {
  const lines = out.split('\n').filter((l) => l.length > 0);
  const matches: GrepMatch[] = [];
  for (const line of lines) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({
      path: m[1]!,
      line: Number.parseInt(m[2]!, 10),
      text: m[3]!,
    });
  }
  return matches;
}
