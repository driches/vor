import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LLMProvider, CanonicalMessage, CanonicalUsage } from '../llm/types.js';
import { parseUnifiedDiff } from '../github/diff-parser.js';
import type {
  FileReadRef,
  PlatformReviewInput,
  PRContext,
  RepoFileReader,
  ReviewPlatform,
} from './types.js';
import { runReviewWithPlatform } from './runner.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '../..');

interface BaselineFixture {
  baseline_sha: string;
  post: {
    event: string;
    body_contains: string[];
    prompt_contains: string[];
    comments: Array<{
      file_path: string;
      line: number;
      severity: string;
      category: string;
      title: string;
      confidence: string;
    }>;
  };
  result: {
    comment_count: number;
    ended: string;
    dry_run: boolean;
  };
}

class FixtureReader implements RepoFileReader {
  constructor(private readonly files: Map<string, string>) {}

  async read(ref: FileReadRef): Promise<string | null> {
    return this.files.get(ref.path) ?? null;
  }

  async readRange(
    ref: FileReadRef,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; total_lines: number; returned_range: [number, number] } | null> {
    const full = await this.read(ref);
    if (full == null) return null;
    const lines = full.split('\n');
    const start = Math.max(1, startLine);
    const end = Math.min(lines.length, endLine);
    return {
      content: lines.slice(start - 1, end).join('\n'),
      total_lines: lines.length,
      returned_range: [start, end],
    };
  }

  async readBinary(ref: FileReadRef): Promise<Buffer | null> {
    const full = await this.read(ref);
    return full == null ? null : Buffer.from(full, 'utf-8');
  }
}

class ScriptedProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private used = false;

  constructor(private readonly inspectMessages?: (messages: CanonicalMessage[]) => void) {}

  async complete(messages: CanonicalMessage[]) {
    this.inspectMessages?.(messages);
    if (this.used) {
      throw new Error('baseline provider called more than once');
    }
    this.used = true;
    return {
      text: '',
      stop_reason: 'tool_calls' as const,
      tool_calls: [
        {
          id: 'toolu_comment',
          name: 'post_inline_comment',
          arguments: {
            severity: 'minor',
            file_path: 'src/app.ts',
            line: 5,
            side: 'RIGHT',
            category: 'readability',
            title: 'Function lacks return type annotation',
            why_it_matters: 'Explicit return types help future readers and TypeScript inference.',
            confidence: 'medium',
          },
        },
        {
          id: 'toolu_summary',
          name: 'post_summary',
          arguments: {
            strengths: ['Clear and focused changes that are easy to follow.'],
            assessment: 'comment',
            assessment_reasoning: 'Small observations; nothing blocking the merge here.',
          },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  }

  inputTokensFullRate(usage: CanonicalUsage): number {
    return usage.input_tokens;
  }
}

describe('runReviewWithPlatform baseline', () => {
  it('preserves the normalized GitHub baseline shape through the platform runner', async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(repoRoot, 'tests/fixtures/platform/github-baseline.json'), 'utf-8'),
    ) as BaselineFixture;
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,4 @@',
      '+export function app() {',
      '+  debugger;',
      '+  return 1;',
      '+}',
    ].join('\n');
    const prContext: PRContext = {
      metadata: {
        number: 1,
        title: 'Baseline PR',
        body: '',
        author: 'doug',
        base_sha: 'base000',
        head_sha: 'head111',
        base_ref: 'main',
        head_ref: 'feature',
        labels: [],
        changed_file_count: 1,
        additions: 4,
        deletions: 0,
        draft: false,
      },
      files: parseUnifiedDiff(`${diff}\n`),
      diff: `${diff}\n`,
    };
    const reader = new FixtureReader(
      new Map([
        [
          '.vor.yml',
          [
            'security:',
            '  enabled: true',
            '  scanners:',
            '    dependency_cve:',
            '      enabled: false',
            '    secrets:',
            '      enabled: false',
            '    sast:',
            '      enabled: false',
            '    debris:',
            '      enabled: true',
            '    migration_safety:',
            '      enabled: false',
            '    dependency_hygiene:',
            '      enabled: false',
            'context:',
            '  blast_radius:',
            '    enabled: false',
          ].join('\n'),
        ],
      ]),
    );
    let posted: PlatformReviewInput | undefined;
    let userPrompt = '';
    const platform: ReviewPlatform = {
      id: 'github',
      displayName: 'GitHub',
      owner: 'driches',
      repo: 'test',
      pull_number: 1,
      repoLabel: 'driches/test',
      authSecrets: ['ghs_test'],
      fileReader: reader,
      fetchPRContext: async () => prContext,
      fetchPriorReviewThreads: async () => [
        {
          file_path: 'src/legacy.ts',
          line: 3,
          outdated: false,
          finding_excerpt: '[IMPORTANT · bug] Existing finding',
          from_dismissable_review: false,
          already_dismissed: false,
          has_pushback: true,
          replies: [{ author: 'author', excerpt: "This is by design; won't fix." }],
        },
      ],
      supersedePriorReviews: async () => 0,
      postReview: async (input) => {
        posted = input;
        return { review_id: 12345, comment_count: input.comments.length };
      },
    };

    const result = await runReviewWithPlatform({
      platform,
      anthropic_api_key: 'sk-ant-test',
      openai_api_key: '',
      config_path: '.vor.yml',
      dry_run: false,
      workspace_dir: repoRoot,
      providerFactory: () =>
        new ScriptedProvider((messages) => {
          userPrompt =
            messages.find(
              (message): message is Extract<CanonicalMessage, { role: 'user' }> =>
                message.role === 'user',
            )?.content ?? '';
        }),
    });

    expect(posted).toBeDefined();
    expect(fixture.baseline_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(posted!.event).toBe(fixture.post.event);
    for (const expected of fixture.post.body_contains) {
      expect(posted!.body).toContain(expected);
    }
    for (const expected of fixture.post.prompt_contains) {
      expect(userPrompt).toContain(expected);
    }
    expect(
      posted!.comments.map((comment) => ({
        file_path: comment.file_path,
        line: comment.line,
        severity: comment.severity,
        category: comment.category,
        title: comment.title,
        confidence: comment.confidence,
      })),
    ).toEqual(fixture.post.comments);
    expect({
      comment_count: result.comment_count,
      ended: result.ended,
      dry_run: result.dry_run,
    }).toEqual(fixture.result);
    expect(result.review_id).toBe(12345);
  });
});
