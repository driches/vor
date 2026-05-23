/**
 * Drive the existing src/orchestrator.runOrchestrator against a LoadedCase
 * instead of a real GitHub PR.
 *
 * Strategy: vi.mock the @octokit/rest and @anthropic-ai/sdk modules at module
 * scope so the orchestrator's createOctokit + runAgent get controllable stubs.
 * The case's `files[]` are served via the mocked `repos.getContent` and a
 * synthesized unified diff is served via `pulls.get(mediaType:'diff')`.
 *
 * CAUTION: this file installs vi.mock at module scope. It is TEST-ONLY —
 * importing from production code would replace those modules globally. Only
 * import from scripts/eval/*.test.ts.
 */
import { vi } from 'vitest';
import type { LoadedCase } from './case-loader.js';
import type { RunRecord } from './types.js';
import type { ReviewConfig } from '../../src/config/types.js';

interface AgentTurnResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use';
}

interface AdapterState {
  agentScript: AgentTurnResponse[];
  caseFiles: Map<string, string>;
  caseDiff: string;
  filesApi: Array<{ filename: string; changes: number; patch: string | null | undefined }>;
  createReviewCalls: Array<{ args: Record<string, unknown> }>;
  costAccum: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    turns: number;
  };
}

const state: AdapterState = {
  agentScript: [],
  caseFiles: new Map(),
  caseDiff: '',
  filesApi: [],
  createReviewCalls: [],
  costAccum: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: 0,
  },
};

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = {
      create: vi.fn(async () => {
        state.costAccum.turns += 1;
        state.costAccum.input_tokens += 100;
        state.costAccum.output_tokens += 50;
        const next = state.agentScript.shift();
        if (!next) {
          throw new Error('agentScript exhausted — test did not script enough turns');
        }
        return {
          id: 'msg_eval',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: next.content,
          stop_reason: next.stop_reason,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      }),
    };
    constructor(_opts: { apiKey: string }) {
      // no-op
    }
  }
  return { default: FakeAnthropic };
});

vi.mock('@octokit/rest', () => {
  class FakeOctokit {
    public rest: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    constructor() {
      this.rest = {
        pulls: {
          get: vi.fn(async (args: { mediaType?: { format?: string } }) => {
            if (args.mediaType?.format === 'diff') {
              return { data: state.caseDiff as unknown };
            }
            return {
              data: {
                number: 1,
                title: 'Eval run',
                body: '',
                user: { login: 'eval' },
                draft: false,
                additions: 1,
                deletions: 0,
                changed_files: state.filesApi.length,
                labels: [],
                head: { sha: 'evalhead', ref: 'feature' },
                base: { sha: 'evalbase', ref: 'main' },
              },
            };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listFiles: vi.fn(async () => ({
            data: state.filesApi,
          })) as unknown as (...args: unknown[]) => Promise<unknown>,
          createReview: vi.fn(async (args: Record<string, unknown>) => {
            state.createReviewCalls.push({ args });
            return { data: { id: 12345 } };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listReviews: vi.fn(async () => ({ data: [] })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
          dismissReview: vi.fn(async () => ({ data: {} })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
        },
        repos: {
          getContent: vi.fn(async (args: { path: string }) => {
            const content = state.caseFiles.get(args.path);
            if (content == null) {
              const err = Object.assign(new Error('Not Found'), { status: 404 });
              throw err;
            }
            return {
              data: {
                type: 'file',
                content: Buffer.from(content, 'utf-8').toString('base64'),
                encoding: 'base64',
              },
            };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
        },
      };
    }
    static plugin() {
      return FakeOctokit;
    }
  }
  return { Octokit: FakeOctokit };
});

// Plugin modules pulled in by createOctokit are no-ops in this context.
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }));

// Import runOrchestrator AFTER the mocks above are registered.
import { runOrchestrator } from '../../src/orchestrator.js';

export interface EvalRunInput {
  case: LoadedCase;
  config: ReviewConfig;
  anthropicApiKey: string;
  agentScript: AgentTurnResponse[];
}

export interface EvalRunOutput {
  findings: RunRecord['findings'];
  cost: RunRecord['cost'];
}

export async function evalRun(input: EvalRunInput): Promise<EvalRunOutput> {
  // Reset shared state for this run.
  state.agentScript = [...input.agentScript];
  state.caseFiles = new Map(input.case.files.map((f) => [f.path, f.content]));
  const { diff, filesApi } = synthesizeDiff(input.case);
  state.caseDiff = diff;
  state.filesApi = filesApi;
  state.createReviewCalls = [];
  state.costAccum = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    turns: 0,
  };

  // The orchestrator's loadConfig will look for .code-review.yml at HEAD; we
  // serve a serialized form of the supplied config so the orchestrator picks
  // up exactly what the test asked for.
  state.caseFiles.set('.code-review.yml', serializeConfigAsYaml(input.config));

  const wallStart = Date.now();
  let endedReason = 'summary_posted';
  try {
    const out = await runOrchestrator({
      owner: 'eval',
      repo: 'eval',
      pull_number: 1,
      anthropic_api_key: input.anthropicApiKey,
      github_token: 'gh-test',
      config_path: '.code-review.yml',
      dry_run: false,
      workspace_dir: '/tmp/eval',
    });
    endedReason = out.ended;
  } catch (err) {
    endedReason = `error: ${(err as Error).message}`;
  }
  const wall_ms = Math.max(1, Date.now() - wallStart);

  const captured = state.createReviewCalls[0]?.args as
    | { comments?: Array<Record<string, unknown>> }
    | undefined;
  const findings: RunRecord['findings'] = (captured?.comments ?? []).map(
    (c) =>
      ({
        severity: 'minor',
        file_path: c.path as string,
        line: c.line as number,
        side: (c.side as 'RIGHT' | 'LEFT') ?? 'RIGHT',
        category: 'security',
        title: '',
        why_it_matters: '',
        confidence: 'medium',
      }) as RunRecord['findings'][number],
  );

  return {
    findings,
    cost: {
      ...state.costAccum,
      cost_usd: state.costAccum.turns * 0.01,
      wall_ms,
      ended_reason: endedReason,
    },
  };
}

function synthesizeDiff(c: LoadedCase): {
  diff: string;
  filesApi: AdapterState['filesApi'];
} {
  // Minimal diff that marks every file as added so `reviewable_lines` and
  // `added_lines` include all content.
  const chunks: string[] = [];
  const filesApi: AdapterState['filesApi'] = [];
  for (const f of c.files) {
    if (f.path === '.code-review.yml') continue;
    const lines = f.content.split('\n');
    // Trim trailing empty string from a final newline so the hunk line count
    // matches the actual added lines.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const lineCount = lines.length;
    if (lineCount === 0) continue;
    const fileChunk: string[] = [];
    fileChunk.push(`diff --git a/${f.path} b/${f.path}`);
    fileChunk.push('new file mode 100644');
    fileChunk.push(`index 0000000..1111111`);
    fileChunk.push(`--- /dev/null`);
    fileChunk.push(`+++ b/${f.path}`);
    fileChunk.push(`@@ -0,0 +1,${lineCount} @@`);
    for (const line of lines) {
      fileChunk.push('+' + line);
    }
    const fileDiff = fileChunk.join('\n');
    chunks.push(fileDiff);
    filesApi.push({
      filename: f.path,
      changes: lineCount,
      patch: fileDiff,
    });
  }
  return { diff: chunks.join('\n') + '\n', filesApi };
}

function serializeConfigAsYaml(cfg: ReviewConfig): string {
  const lines: string[] = [];
  lines.push(`model: ${cfg.model}`);
  lines.push(`max_turns: ${cfg.max_turns}`);
  lines.push('severity:');
  lines.push(`  floor: ${cfg.severity.floor}`);
  lines.push(`  max_comments_per_file: ${cfg.severity.max_comments_per_file}`);
  lines.push(`  max_comments_total: ${cfg.severity.max_comments_total}`);
  lines.push('budget:');
  lines.push(`  max_input_tokens: ${cfg.budget.max_input_tokens}`);
  lines.push(`  max_output_tokens: ${cfg.budget.max_output_tokens}`);
  lines.push('security:');
  lines.push(`  enabled: ${cfg.security.enabled}`);
  lines.push('  scanners:');
  lines.push('    dependency_cve:');
  lines.push(`      enabled: ${cfg.security.scanners.dependency_cve.enabled}`);
  lines.push('    secrets:');
  lines.push(`      enabled: ${cfg.security.scanners.secrets.enabled}`);
  if (cfg.security.scanners.secrets.include_generic_entropy !== undefined) {
    lines.push(
      `      include_generic_entropy: ${cfg.security.scanners.secrets.include_generic_entropy}`,
    );
  }
  return lines.join('\n') + '\n';
}
