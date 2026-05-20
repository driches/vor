/**
 * Convert captured GitHub PR review JSON into NormalizedFinding[].
 *
 * Bots (Codex, Coderabbit, etc.) don't expose severity/category as structured
 * fields — they live as Markdown prefixes inside `comment.body`. This module
 * parses them with a configurable `BotConfig` (regex + map) so we can re-derive
 * normalized output later without re-fetching, and so different bots can be
 * compared without touching the harness.
 *
 * Capture flow stores BOTH the raw `review.json` (the GitHub API responses)
 * AND `normalized.json` (output of this module). The raw payload is the
 * ground truth — if the regex was wrong, re-run normalization without
 * re-hitting the API.
 */

import type { Category, Severity } from '../types.js';
import type { NormalizedFinding } from './finding.js';

/**
 * How to interpret one bot's review comments. `severityRegex` is matched
 * against the comment body; capture group 1 is looked up in `severityMap`
 * after lower-casing. Same shape for the optional category extraction.
 */
export interface BotConfig {
  /** Exact GitHub `user.login` to filter on. */
  userLogin: string;
  /** Friendly label used in reports. */
  displayName: string;
  /** Capture group 1 = severity token. */
  severityRegex: RegExp;
  /** Lower-cased token → our Severity. Unmapped tokens become 'unknown'. */
  severityMap: Record<string, Severity>;
  /** Optional: capture group 1 = category token. */
  categoryRegex?: RegExp;
  categoryMap?: Record<string, Category>;
  /** Optional override for the title extractor. Default: first non-blank line. */
  titleExtractor?: (body: string) => string | undefined;
}

/**
 * Subset of `octokit.pulls.listReviewComments` we read.
 *
 * GitHub returns `line: null` for "outdated" comments (the line the bot
 * commented on no longer exists in the PR's current HEAD because the author
 * pushed more commits). `original_line` is preserved in that case and still
 * tells us where the bot found the issue at the time it reviewed. We persist
 * both so the comparison can fall back gracefully.
 */
export interface GitHubReviewComment {
  id: number;
  path: string;
  line: number | null;
  start_line?: number | null;
  original_line?: number | null;
  original_start_line?: number | null;
  side?: 'LEFT' | 'RIGHT';
  body: string;
  user: { login: string } | null;
  in_reply_to_id?: number;
}

/** Subset of `octokit.pulls.listReviews` we read. */
export interface GitHubReview {
  id: number;
  body: string | null;
  state: string;
  user: { login: string } | null;
  submitted_at: string | null;
}

/**
 * Persisted shape for `<caseDir>/codex/review.json`. Holds both endpoints so
 * one file is the full captured surface for that bot.
 */
export interface CapturedBotReview {
  bot_user: string;
  reviews: GitHubReview[];
  comments: GitHubReviewComment[];
}

export function normalizeReview(input: {
  captured: CapturedBotReview;
  bot: BotConfig;
}): NormalizedFinding[] {
  return input.captured.comments
    .filter((c) => c.user?.login === input.bot.userLogin)
    .filter((c) => c.in_reply_to_id == null)
    .map((c) => normalizeComment(c, input.bot));
}

function normalizeComment(c: GitHubReviewComment, bot: BotConfig): NormalizedFinding {
  const severity = inferSeverity(c.body, bot);
  const category = inferCategory(c.body, bot);
  const title = (bot.titleExtractor ?? extractFirstLine)(c.body);
  // Prefer current-HEAD line. Fall back to original_line when GitHub marks
  // the comment as outdated (later commits pushed past it). This may not
  // align with our HEAD findings line-for-line, but the hunk-id matcher in
  // compare.ts still finds the same logical region.
  const line = c.line ?? c.start_line ?? c.original_line ?? c.original_start_line ?? 0;
  return {
    source: 'codex',
    file_path: c.path,
    line,
    severity,
    category,
    ...(title ? { title } : {}),
    body: c.body,
    raw: c,
  };
}

function inferSeverity(body: string, bot: BotConfig): Severity | 'unknown' {
  const m = body.match(bot.severityRegex);
  if (!m || !m[1]) return 'unknown';
  return bot.severityMap[m[1].toLowerCase()] ?? 'unknown';
}

function inferCategory(body: string, bot: BotConfig): Category | 'unknown' {
  if (!bot.categoryRegex || !bot.categoryMap) return 'unknown';
  const m = body.match(bot.categoryRegex);
  if (!m || !m[1]) return 'unknown';
  return bot.categoryMap[m[1].toLowerCase()] ?? 'unknown';
}

function extractFirstLine(body: string): string | undefined {
  const first = body.split('\n').find((l) => l.trim().length > 0);
  if (!first) return undefined;
  const cleaned = first.replace(/^[*_#>\-`\s]+|[*_`\s]+$/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : undefined;
}

/**
 * Default Codex config matching OpenAI's GitHub-native reviewer as it appears
 * on driches/* repos (login: `chatgpt-codex-connector[bot]`). Severity is
 * embedded in a Shields.io badge image at the start of the body, e.g.
 *
 *   **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange...)</sub></sub>  Title**
 *
 * We word-boundary-match `P1`/`P2`/`P3` (or fallback to `Critical`/`Important`
 * /`Minor`/`Nit` word prefixes for non-badge bots). The title extractor
 * strips the `<sub>![…](…)</sub>` wrapper so report tables stay readable.
 *
 * If your install uses a different login (e.g. `codex[bot]`), pass it
 * literally via `--bot <login>` and the BotConfig falls back to "no severity
 * inference"; you can then re-run normalization with a tuned config.
 */
export const CODEX_BOT: BotConfig = {
  userLogin: 'chatgpt-codex-connector[bot]',
  displayName: 'Codex',
  severityRegex: /\b(P[1-3]|critical|important|minor|nit)\b/i,
  severityMap: {
    p1: 'critical',
    p2: 'important',
    p3: 'minor',
    critical: 'critical',
    important: 'important',
    minor: 'minor',
    nit: 'nit',
  },
  titleExtractor: (body) => {
    const stripped = body
      .replace(/<sub>!\[[^\]]*\]\([^)]*\)<\/sub>/g, '')
      .replace(/<\/?sub>/g, '');
    const first = stripped.split('\n').find((l) => l.trim().length > 0);
    if (!first) return undefined;
    const cleaned = first.replace(/^[*_#>\-`\s]+|[*_`\s]+$/g, '').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 120) : undefined;
  },
};

/**
 * Default Coderabbit config. Coderabbit tags categories in italicized
 * markers like `_potential issue_` or `_nitpick_`.
 */
export const CODERABBIT_BOT: BotConfig = {
  userLogin: 'coderabbitai[bot]',
  displayName: 'Coderabbit',
  // Tokens appear inside Markdown italics, often prefixed with an emoji marker
  // like `_⚠️ potential issue_`. Allow up to 40 non-underscore chars on either
  // side of the token within the italic span.
  severityRegex: /_[^_]{0,40}(potential issue|nitpick|suggestion|warning|refactor)[^_]{0,40}_/i,
  severityMap: {
    'potential issue': 'important',
    warning: 'important',
    suggestion: 'minor',
    refactor: 'minor',
    nitpick: 'nit',
  },
};
