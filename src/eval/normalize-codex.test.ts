import { describe, expect, it } from 'vitest';
import {
  CODEX_BOT,
  CODERABBIT_BOT,
  normalizeReview,
  type CapturedBotReview,
} from './normalize-codex.js';

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';

function comment(
  overrides: Partial<{
    id: number;
    path: string;
    line: number;
    body: string;
    login: string;
    in_reply_to_id?: number;
  }>,
): CapturedBotReview['comments'][number] {
  return {
    id: overrides.id ?? 1,
    path: overrides.path ?? 'src/foo.ts',
    line: overrides.line ?? 10,
    body: overrides.body ?? '',
    user: { login: overrides.login ?? CODEX_LOGIN },
    ...(overrides.in_reply_to_id !== undefined ? { in_reply_to_id: overrides.in_reply_to_id } : {}),
  };
}

function captured(comments: CapturedBotReview['comments']): CapturedBotReview {
  return { bot_user: CODEX_LOGIN, reviews: [], comments };
}

describe('normalizeReview - CODEX_BOT', () => {
  it('extracts severity from "P1 Bug:" prefix', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: 'P1 Bug: this throws on null user' })]),
      bot: CODEX_BOT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('critical');
    expect(out[0]!.source).toBe('codex');
    expect(out[0]!.file_path).toBe('src/foo.ts');
    expect(out[0]!.line).toBe(10);
  });

  it('extracts severity from "**P2 issue**" markdown', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: '**P2 issue:** missing await on the promise' })]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.severity).toBe('important');
  });

  it('extracts severity from "Critical:" word prefix', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: 'Critical: race condition on the queue' })]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.severity).toBe('critical');
  });

  it('maps P3 to minor and Nit to nit', () => {
    const out = normalizeReview({
      captured: captured([
        comment({ id: 1, body: 'P3: naming nit' }),
        comment({ id: 2, body: 'Nit: trailing comma' }),
      ]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.severity).toBe('minor');
    expect(out[1]!.severity).toBe('nit');
  });

  it('returns "unknown" severity when no prefix matches', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: 'Just a comment with no tag.' })]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.severity).toBe('unknown');
  });

  it('filters to comments by the configured bot login', () => {
    const out = normalizeReview({
      captured: captured([
        comment({ id: 1, body: 'P1: real finding' }),
        comment({ id: 2, login: 'alice', body: 'P1: a human reply' }),
      ]),
      bot: CODEX_BOT,
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.raw as { id: number }).id).toBe(1);
  });

  it('extracts severity from the Shields.io badge format used by chatgpt-codex-connector', () => {
    const out = normalizeReview({
      captured: captured([
        comment({
          body:
            '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Send auth_ok when connection is pre-authenticated**\n\n' +
            'When `AUTH_BYPASS` is enabled the early return drops the auth message.',
        }),
      ]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.severity).toBe('critical');
    expect(out[0]!.title).toContain('Send auth_ok when connection is pre-authenticated');
    expect(out[0]!.title).not.toContain('Badge');
    expect(out[0]!.title).not.toContain('<sub>');
  });

  it('drops replies (comments with in_reply_to_id)', () => {
    const out = normalizeReview({
      captured: captured([
        comment({ id: 1, body: 'P1: original' }),
        comment({ id: 2, body: 'P1: reply', in_reply_to_id: 1 }),
      ]),
      bot: CODEX_BOT,
    });
    expect(out).toHaveLength(1);
  });

  it('extracts a title from the first non-blank line', () => {
    const out = normalizeReview({
      captured: captured([
        comment({
          body: '**P1 Bug**: Possible null deref\n\nThe `user` field can be null when ...',
        }),
      ]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.title).toContain('Possible null deref');
  });

  it('passes through the original comment as `raw`', () => {
    const c = comment({ id: 42, body: 'P1: foo' });
    const out = normalizeReview({ captured: captured([c]), bot: CODEX_BOT });
    expect(out[0]!.raw).toBe(c);
  });

  it('handles null line (multi-line comments use start_line)', () => {
    const out = normalizeReview({
      captured: captured([
        {
          id: 1,
          path: 'src/foo.ts',
          line: null,
          start_line: 5,
          body: 'P1: spans lines 5–10',
          user: { login: CODEX_LOGIN },
        },
      ]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.line).toBe(5);
  });
});

describe('normalizeReview - CODERABBIT_BOT', () => {
  it('extracts severity from "_potential issue_" marker', () => {
    const out = normalizeReview({
      captured: {
        bot_user: 'coderabbitai[bot]',
        reviews: [],
        comments: [
          comment({
            login: 'coderabbitai[bot]',
            body: '_:warning: potential issue_\n\nMissing await on async call.',
          }),
        ],
      },
      bot: CODERABBIT_BOT,
    });
    expect(out[0]!.severity).toBe('important');
  });

  it('treats nitpick as nit-severity', () => {
    const out = normalizeReview({
      captured: {
        bot_user: 'coderabbitai[bot]',
        reviews: [],
        comments: [
          comment({
            login: 'coderabbitai[bot]',
            body: '_nitpick_: trailing whitespace',
          }),
        ],
      },
      bot: CODERABBIT_BOT,
    });
    expect(out[0]!.severity).toBe('nit');
  });
});

describe('normalizeReview - category extraction', () => {
  it('extracts category when categoryRegex is configured', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: '[CRITICAL · security] Missing CSRF token' })]),
      bot: {
        ...CODEX_BOT,
        categoryRegex: /·\s*([a-z-]+)\s*\]/i,
        categoryMap: { security: 'security', bug: 'bug', 'data-loss': 'data-loss' },
      },
    });
    expect(out[0]!.category).toBe('security');
  });

  it('returns "unknown" category when no map is configured', () => {
    const out = normalizeReview({
      captured: captured([comment({ body: 'P1: something' })]),
      bot: CODEX_BOT,
    });
    expect(out[0]!.category).toBe('unknown');
  });
});
