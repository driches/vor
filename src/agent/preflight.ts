/**
 * Pre-flight Haiku skim — runs once before Sonnet's tool loop.
 *
 * Why: in v0.2.x baseline Sonnet's first action is `get_pr_diff`, which
 * returns 50-100KB of unified diff that then sits in the message-history
 * cache for ALL subsequent turns at the cache_read rate. On a 30-turn case
 * that's ~3M cached tokens billed at $0.30/M = $0.90 from a single tool
 * result. The pre-flight call replaces that pattern: Haiku reads the diff
 * + file list ONCE, produces a 1-2KB structured candidate list, and we
 * inject that into Sonnet's initial user prompt. Sonnet's first turn now
 * has focused candidates to verify rather than 100KB of raw hunks to scan.
 *
 * Recall safety: candidates are presented as advisory ("verify
 * independently before posting"). Sonnet still has `get_pr_diff` available
 * and the read-before-post validator enforces that critical/important
 * posts get a real Sonnet read. Pre-flight is a HEAD START, not a
 * replacement for Sonnet's own investigation.
 *
 * Cost shape (typical PR):
 *   - Haiku input ≈ 25-30K (diff + files + context), output ≈ 1-2K
 *   - Per-call cost ≈ $0.03-0.05
 *   - Expected Sonnet-side savings: $0.50-1.50 per PR from a smaller cache
 *     pool and shorter loop. See CHANGELOG for measured impact.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Budget } from '../util/budget.js';
import { logger } from '../util/logger.js';
import type { PRContext } from '../github/pr-context.js';

const candidateSchema = z.object({
  file: z.string(),
  line_range: z.string().describe("e.g. '42-58' or '42'"),
  severity_guess: z.enum(['critical', 'important', 'minor', 'nit']),
  category: z.string(),
  what: z.string().min(1).max(240),
  why: z.string().min(1).max(360),
});

const preflightSchema = z.object({
  candidates: z.array(candidateSchema).max(20),
  low_risk_files: z.array(z.string()).default([]),
  global_observations: z.array(z.string().max(200)).default([]),
});

export type PreflightAnalysis = z.infer<typeof preflightSchema>;

const PREFLIGHT_SYSTEM = `You are a fast-scan analyst preparing a pull request for a senior reviewer.

Your job: read the diff and file list, then return a structured JSON list of EVERY plausibly-flaggable concern. The senior reviewer is the one who decides what to post — your job is to give them a focused starting list so they don't have to wide-scan the diff themselves.

Be GENEROUS in candidates but TIGHT in language. The reviewer prefers a list of 8 candidates they triage in 3 turns over a perfect list of 3 they have to mine themselves.

Severity guidance:
- critical: data loss, auth bypass, RCE, crash on common path, secret leak, race with user impact
- important: error handling missing on a likely-failing external call, N+1, breaking change to an internal contract, missing test coverage on core logic
- minor: naming that obscures intent (with a concrete suggestion), missing JSDoc on exported API, inconsistent pattern usage
- nit: style preferences when there's no documented convention

Categories (free-text but prefer): bug | security | performance | error-handling | test-gap | readability | docs | architecture | vulnerability

OUTPUT REQUIREMENTS (no exceptions):
- Return ONLY JSON matching this schema. No markdown fences. No prose before or after.
- Use this exact shape:
{
  "candidates": [
    {
      "file": "path/relative/to/repo.ts",
      "line_range": "42-58",   // OR a single line like "42"
      "severity_guess": "important",
      "category": "error-handling",
      "what": "1-sentence headline",
      "why": "1-2 sentence reasoning"
    }
  ],
  "low_risk_files": ["paths the reviewer can skip without reading"],
  "global_observations": ["Cross-cutting observations the senior reviewer should know"]
}

Constraints:
- At most 20 candidates. If you'd flag more, return the top 20 by severity.
- File paths must match exactly the paths in the diff.
- Line ranges must fall within the changed hunks of that file.
- If the diff is small and benign, returning {"candidates": [], ...} is correct.`;

export async function runPreflight(input: {
  client: Anthropic;
  budget: Budget;
  model: string;
  prContext: PRContext;
}): Promise<PreflightAnalysis | null> {
  const fileSummary = input.prContext.files
    .map(
      (f) =>
        `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}${
          f.is_generated ? ', generated' : ''
        }${f.is_binary ? ', binary' : ''})`,
    )
    .join('\n');

  const userPrompt = [
    `## PR metadata`,
    `Title: ${input.prContext.metadata.title}`,
    input.prContext.metadata.body.trim().length > 0
      ? `Body: ${input.prContext.metadata.body.slice(0, 1000)}`
      : 'Body: (empty)',
    '',
    `## Changed files (${input.prContext.files.length})`,
    fileSummary,
    '',
    `## Unified diff`,
    '```diff',
    input.prContext.diff,
    '```',
    '',
    'Return ONLY the JSON described in your instructions.',
  ].join('\n');

  let response: Anthropic.Message;
  try {
    response = await input.client.messages.create({
      model: input.model,
      max_tokens: 2048,
      temperature: 0,
      system: PREFLIGHT_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    await logger.warn(
      `Pre-flight call failed: ${(err as Error).message}. Continuing without pre-analysis.`,
    );
    return null;
  }

  try {
    input.budget.addUsage(input.model, response.usage);
  } catch (err) {
    // BudgetError propagates — same rule as the worker tool. Let the
    // runner's outer handler flip to 'budget_exceeded'.
    throw err;
  }

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (textBlock === undefined) {
    await logger.warn('Pre-flight returned no text block. Continuing without pre-analysis.');
    return null;
  }

  const rawText = textBlock.text;
  const json = stripJsonFence(rawText);

  let unvalidated: unknown;
  try {
    unvalidated = JSON.parse(json);
  } catch (err) {
    await logger.warn(
      `Pre-flight produced non-JSON output: ${(err as Error).message}. Continuing without pre-analysis.`,
    );
    return null;
  }

  const validation = preflightSchema.safeParse(unvalidated);
  if (!validation.success) {
    await logger.warn(
      `Pre-flight JSON failed schema validation: ${validation.error.message}. Continuing without pre-analysis.`,
    );
    return null;
  }

  await logger.info(
    `Pre-flight: ${validation.data.candidates.length} candidate(s), ${validation.data.low_risk_files.length} low-risk file(s), ${validation.data.global_observations.length} global observation(s)`,
  );

  return validation.data;
}

/**
 * Render the pre-flight analysis into a section that gets prepended to
 * Sonnet's user prompt.
 *
 * Why we render the FULL changed-file list (not just the candidates):
 * earlier iterations showed Sonnet treats the candidate list as exhaustive
 * — files not on the list got skipped, and real findings in those files
 * were missed (e.g. discover.ts:127 N+1 on `code-review-pr-6`, Iter 2).
 * By listing every changed file with a "candidate" or "no candidates
 * flagged" annotation, an unflagged file still appears in the prompt and
 * gets investigated rather than silently dropped. The cost-shift win
 * (fewer turns, smaller cache pool) comes from candidates focusing
 * Sonnet's attention; this addition is the safety belt against pre-flight
 * misses.
 */
export function renderPreflightSection(
  analysis: PreflightAnalysis,
  changedFiles: ReadonlyArray<{ path: string; status: string; additions: number; deletions: number }>,
): string {
  const lines: string[] = [];
  lines.push('## Pre-analysis (advisory — verify independently before posting)');
  lines.push('');
  lines.push(
    'A faster model has scanned the diff. Its candidates appear below the file list. ' +
      'Treat them as a STARTING LIST, not as findings to post verbatim, and ' +
      'do NOT treat absence-from-the-list as "nothing to flag here" — ' +
      'pre-analysis routinely misses real findings.',
  );
  lines.push('');

  const filesByCandidate = new Map<string, typeof analysis.candidates>();
  for (const c of analysis.candidates) {
    const existing = filesByCandidate.get(c.file) ?? [];
    existing.push(c);
    filesByCandidate.set(c.file, existing);
  }
  const lowRiskSet = new Set(analysis.low_risk_files);

  lines.push(`### Files in this PR (${changedFiles.length})`);
  lines.push(
    'Files marked "no candidates" still need a quick scan — pre-analysis catches roughly 70% of real findings. A 1-2 turn scan is usually enough; only go deep if you spot something concrete.',
  );
  lines.push('');
  for (const f of changedFiles) {
    const flagged = filesByCandidate.get(f.path);
    const lowRisk = lowRiskSet.has(f.path);
    let annotation: string;
    if (flagged !== undefined && flagged.length > 0) {
      annotation = `${flagged.length} candidate(s)`;
    } else if (lowRisk) {
      annotation = 'low-risk';
    } else {
      annotation = 'no candidates';
    }
    lines.push(`- \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions}) — ${annotation}`);
  }
  lines.push('');

  if (analysis.candidates.length === 0) {
    lines.push('**No candidates flagged across any file.** Investigate the diff yourself — the pre-analysis may have missed everything.');
  } else {
    lines.push(`### ${analysis.candidates.length} candidate(s) (advisory)`);
    lines.push('');
    for (let i = 0; i < analysis.candidates.length; i++) {
      const c = analysis.candidates[i]!;
      lines.push(
        `${i + 1}. **${c.file}:${c.line_range}** — ${c.severity_guess.toUpperCase()} (${c.category})`,
      );
      lines.push(`   What: ${c.what}`);
      lines.push(`   Why: ${c.why}`);
    }
    lines.push('');
  }

  if (analysis.global_observations.length > 0) {
    lines.push(`### Global observations`);
    for (const o of analysis.global_observations) lines.push(`- ${o}`);
    lines.push('');
  }

  return lines.join('\n');
}

function stripJsonFence(text: string): string {
  let s = text.trim();
  if (s.startsWith('```json')) s = s.slice('```json'.length);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}
