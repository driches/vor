import { describe, expect, it } from 'vitest';
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalUsage,
  CompleteOptions,
  LLMProvider,
} from '../llm/types.js';
import { runReviewWithPlatform } from '../platform/runner.js';
import { AGENT_REVIEW_MARKER } from '../platform/review-marker.js';
import { createBitbucketPlatform } from './platform.js';

const CONFIG = [
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
  'review:',
  '  sticky: true',
].join('\n');

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 3333333..4444444 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -4,0 +5,4 @@',
  '+export function app() {',
  '+  debugger;',
  '+  return 1;',
  '+}',
  '',
].join('\n');

interface StoredComment {
  id: number;
  content: { raw: string };
  inline?: { path: string; from?: number; to?: number };
  resolution?: { type: string };
}

class FakeBitbucketService {
  readonly comments: StoredComment[] = [];
  readonly requests: Array<{ method: string; path: string }> = [];
  private nextCommentId = 1;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path });

    if (method === 'GET' && path.endsWith('/pullrequests/3')) {
      return jsonResponse({
        id: 3,
        title: 'Bitbucket integration PR',
        description: 'Exercise the full review pipeline.',
        author: { nickname: 'dev' },
        source: { branch: { name: 'feature' }, commit: { hash: 'head111' } },
        destination: { branch: { name: 'main' }, commit: { hash: 'base000' } },
      });
    }
    if (method === 'GET' && path.endsWith('/pullrequests/3/diff')) {
      return new Response(DIFF);
    }
    if (method === 'GET' && path.endsWith('/pullrequests/3/diffstat')) {
      return jsonResponse({
        values: [
          {
            status: 'modified',
            lines_added: 4,
            lines_removed: 0,
            new: { path: 'src/app.ts' },
          },
        ],
      });
    }
    if (method === 'GET' && path.includes('/src/head111/')) {
      return path.endsWith('/.vor.yml')
        ? new Response(CONFIG)
        : jsonResponse({ error: 'missing' }, 404);
    }
    if (method === 'GET' && path.endsWith('/pullrequests/3/comments')) {
      return jsonResponse({ values: this.comments });
    }
    if (method === 'POST' && path.endsWith('/pullrequests/3/comments')) {
      const body = JSON.parse(String(init?.body)) as {
        content: { raw: string };
        inline?: { path: string; from?: number; to?: number };
      };
      const comment: StoredComment = {
        id: this.nextCommentId++,
        content: body.content,
        ...(body.inline !== undefined ? { inline: body.inline } : {}),
      };
      this.comments.push(comment);
      return jsonResponse(comment, 201);
    }
    const resolveMatch = path.match(/\/comments\/(\d+)\/resolve$/);
    if (method === 'POST' && resolveMatch) {
      const comment = this.comments.find((candidate) => candidate.id === Number(resolveMatch[1]));
      if (!comment) return jsonResponse({ error: 'missing' }, 404);
      comment.resolution = { type: 'RESOLVED' };
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && (path.endsWith('/approve') || path.endsWith('/request-changes'))) {
      return jsonResponse({ error: 'state not set' }, 404);
    }
    if (method === 'POST' && (path.endsWith('/approve') || path.endsWith('/request-changes'))) {
      return jsonResponse({ state: 'updated' });
    }
    return jsonResponse({ error: `unhandled ${method} ${path}` }, 404);
  };

  mutatingRequestCount(): number {
    return this.requests.filter((request) => request.method !== 'GET').length;
  }
}

class IntegrationProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private used = false;

  constructor(
    private readonly inspect?: (messages: CanonicalMessage[], opts: CompleteOptions) => void,
  ) {}

  async complete(messages: CanonicalMessage[], _tools: CanonicalTool[], opts: CompleteOptions) {
    if (this.used) throw new Error('integration provider called more than once');
    this.used = true;
    this.inspect?.(messages, opts);
    return {
      text: '',
      stop_reason: 'tool_calls' as const,
      tool_calls: [
        {
          id: 'agent-comment',
          name: 'post_inline_comment',
          arguments: {
            severity: 'minor',
            file_path: 'src/app.ts',
            line: 5,
            side: 'RIGHT',
            category: 'readability',
            title: 'Function lacks return type annotation',
            why_it_matters: 'An explicit return type makes the public contract clear.',
            confidence: 'medium',
          },
        },
        {
          id: 'agent-summary',
          name: 'post_summary',
          arguments: {
            strengths: ['The change is focused.'],
            assessment: 'comment',
            assessment_reasoning: 'The review found two non-blocking issues.',
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Bitbucket platform integration', () => {
  it('posts, supersedes, and dry-runs through the shared review pipeline', async () => {
    const service = new FakeBitbucketService();
    const platform = createBitbucketPlatform({
      workspace: 'ws',
      repoSlug: 'repo',
      pullRequestId: 3,
      email: 'bot@example.com',
      apiToken: 'token123',
      apiBaseUrl: 'https://bitbucket.example/2.0',
      fetchImpl: service.fetch as typeof fetch,
    });
    const seenSystems: string[] = [];
    const run = (dryRun: boolean) =>
      runReviewWithPlatform({
        platform,
        anthropic_api_key: 'sk-ant-test',
        openai_api_key: '',
        config_path: '.vor.yml',
        dry_run: dryRun,
        workspace_dir: '/tmp/bitbucket-integration-workspace',
        providerFactory: () =>
          new IntegrationProvider((_messages, opts) => {
            seenSystems.push(opts.system);
          }),
      });

    const first = await run(false);
    expect(first).toMatchObject({ post_id: '1', comment_count: 2, dry_run: false });
    expect(first.kept_comments.map((comment) => [comment.line, comment.title])).toEqual([
      [5, 'Function lacks return type annotation'],
      [6, 'Leftover `debugger` statement in app.ts'],
    ]);
    expect(service.comments).toHaveLength(3);
    expect(service.comments[0]!.content.raw).toContain(AGENT_REVIEW_MARKER);
    expect(service.comments[0]!.inline).toBeUndefined();
    expect(service.comments.slice(1).map((comment) => comment.inline?.to)).toEqual([5, 6]);
    expect(seenSystems[0]).toContain('Bitbucket pull request');

    const second = await run(false);
    expect(second).toMatchObject({ post_id: '4', comment_count: 2, dry_run: false });
    expect(service.comments[0]!.resolution).toBeUndefined();
    expect(service.comments[1]!.resolution).toEqual({ type: 'RESOLVED' });
    expect(service.comments[2]!.resolution).toEqual({ type: 'RESOLVED' });
    expect(service.comments).toHaveLength(6);

    const writesBeforeDryRun = service.mutatingRequestCount();
    const dryRun = await run(true);
    expect(dryRun).toMatchObject({ comment_count: 2, dry_run: true });
    expect(service.mutatingRequestCount()).toBe(writesBeforeDryRun);
    expect(service.comments).toHaveLength(6);
  });
});
