/**
 * Integration test for the parallel scanner + agent path through the orchestrator.
 *
 * This is the most ambitious test in the suite because it exercises the whole
 * pipeline end-to-end: the agent loop, the parallel scanner runner, the Pass-2
 * dedup, the validate + adapt step, and the final review post — all with the
 * real `runOrchestrator(input)` entry point. External dependencies are mocked
 * at the module boundary via `vi.mock`:
 *
 *   - `@anthropic-ai/sdk`  → scripted `messages.create` responses that drive
 *                            the agent through a deterministic tool-use loop.
 *   - `@octokit/rest`      → canned responses for `pulls.get`, `pulls.getDiff`,
 *                            `pulls.listFiles`, `repos.getContent`, plus a
 *                            capture-and-resolve `pulls.createReview` so we can
 *                            inspect what the orchestrator submitted.
 *
 * Coverage strategy — secrets AND dependency-cve:
 *
 *   We exercise the happy path twice. Scenario 1 plants an AWS access key in a
 *   regular source file and lets the `secrets` scanner pick it up — the
 *   simplest "scanner finding survives merge/dedup/adapter" assertion.
 *   Scenario 3 reinstates a true dependency-cve happy path: a lockfile change
 *   (`package-lock.json`, lodash 4.17.20 → CVE-2019-10744) flows all the way
 *   to the posted review carrying the `via OSV` provenance tag. (Earlier this
 *   was blocked because `validateScanFinding` refused to post on
 *   `is_generated` files; that check has been removed for scanner findings
 *   since lockfiles are the canonical anchor for dependency CVEs.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------
// Mock script controller — set BEFORE importing the orchestrator.
// -----------------------------------------------------------------
//
// `agentScript` is the queue of pre-baked `messages.create` responses for the
// next test. Each turn of the agent pops the head off this array, so tests
// just push one or two responses describing the agent's behavior.
//
// `octokitState` is mutated by tests to drive what canned data the octokit
// mock returns (config YAML, ignore file, source-file content lookups).
interface AgentTurnResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use';
}

const agentScript: AgentTurnResponse[] = [];

// Optional handle the SDK mock yields on each `messages.create` call so a test
// can force ordering between the agent loop and the scanner runner. Default is
// undefined (no synchronization); the parallel-execution test below installs
// a deferred promise here.
let agentTurnGate: Promise<void> | undefined;

// Optional callback fired the first time OSV.queryBatch is invoked. Used by
// the parallel-execution test to release `agentTurnGate` so the agent only
// proceeds after the scanner has started.
let onFirstOsvCall: (() => void) | undefined;

// Octokit mock — state mutated between tests.
interface OctokitState {
  diff: string;
  filesApi: Array<{ filename: string; changes: number; patch: string | null | undefined }>;
  pullData: Record<string, unknown>;
  // Path → string content (or null for 404).
  contents: Map<string, string | null>;
  priorReviews: Array<{ id: number; state: string; body: string }>;
  // createReview captures.
  createReviewCalls: Array<{ args: Record<string, unknown>; at: number }>;
}

const octokitState: OctokitState = {
  diff: '',
  filesApi: [],
  pullData: {},
  contents: new Map(),
  priorReviews: [],
  createReviewCalls: [],
};

// -----------------------------------------------------------------
// vi.mock — @anthropic-ai/sdk
// -----------------------------------------------------------------
//
// The orchestrator's agent runner imports `Anthropic` as the default export
// and calls `new Anthropic({ apiKey })` to get a client with `messages.create`.
// We swap that whole module so the constructor returns a thin stub that pops
// from `agentScript` on each call.
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = {
      create: vi.fn(async () => {
        // If a parallel-execution test installed a gate, wait for it before
        // returning the scripted response.
        if (agentTurnGate) await agentTurnGate;
        const next = agentScript.shift();
        if (!next) {
          throw new Error('agentScript exhausted — test did not script enough turns');
        }
        return {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
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

// -----------------------------------------------------------------
// vi.mock — openai
// -----------------------------------------------------------------
//
// Mirror of the Anthropic mock above so the OpenAI-path tests (added in
// Task 5) can drive the same orchestrator end-to-end without a real network
// hit. The OpenAI happy-path test enqueues onto `openaiScript`; tests that
// stay on the Anthropic path never touch this queue.
interface OpenAIScriptResponse {
  output: Array<Record<string, unknown>>;
  status: 'completed' | 'incomplete' | 'failed';
}

const openaiScript: OpenAIScriptResponse[] = [];
// Captured constructor arg per `new OpenAI({ apiKey })`. The OpenAI no-key
// test asserts this NEVER got called (orchestrator short-circuited before
// instantiating the provider).
const openaiCtorCalls: Array<{ apiKey: string }> = [];

vi.mock('openai', () => {
  class FakeOpenAI {
    public responses = {
      create: vi.fn(async () => {
        const next = openaiScript.shift();
        if (!next) {
          throw new Error('openaiScript exhausted — test did not script enough turns');
        }
        return {
          id: 'resp_test',
          object: 'response',
          created_at: 0,
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          model: 'gpt-4.1',
          output: next.output,
          parallel_tool_calls: false,
          temperature: null,
          tool_choice: 'auto',
          tools: [],
          top_p: null,
          status: next.status,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
      }),
    };
    constructor(opts: { apiKey: string }) {
      openaiCtorCalls.push({ apiKey: opts.apiKey });
    }
  }
  return { default: FakeOpenAI };
});

// -----------------------------------------------------------------
// vi.mock — @octokit/rest
// -----------------------------------------------------------------
//
// `createOctokit` (in src/github/client.ts) wraps `Octokit.plugin(retry,
// throttling)` and `new`s the resulting class. We mock the module to return a
// stub class whose constructor synthesizes a `rest` namespace that maps to
// `octokitState` plus a `createReview` capturer.
vi.mock('@octokit/rest', () => {
  class FakeOctokit {
    public rest: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    constructor() {
      this.rest = {
        pulls: {
          get: vi.fn(async (args: { mediaType?: { format?: string } }) => {
            if (args.mediaType?.format === 'diff') {
              return { data: octokitState.diff as unknown };
            }
            return { data: octokitState.pullData as unknown };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listFiles: vi.fn(async () => ({ data: octokitState.filesApi })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
          createReview: vi.fn(async (args: Record<string, unknown>) => {
            octokitState.createReviewCalls.push({ args, at: Date.now() });
            return { data: { id: 12345 } };
          }) as unknown as (...args: unknown[]) => Promise<unknown>,
          listReviews: vi.fn(async () => ({ data: octokitState.priorReviews })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
          dismissReview: vi.fn(async () => ({ data: {} })) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>,
        },
        repos: {
          getContent: vi.fn(async (args: { path: string }) => {
            const value = octokitState.contents.get(args.path);
            if (value == null) {
              const err = Object.assign(new Error('Not Found'), { status: 404 });
              throw err;
            }
            return {
              data: {
                type: 'file',
                content: Buffer.from(value, 'utf-8').toString('base64'),
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

// The plugin modules don't need real behavior — the FakeOctokit.plugin() above
// is what's actually used. Still mock them so any incidental import is harmless.
vi.mock('@octokit/plugin-retry', () => ({ retry: {} }));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: {} }));

// -----------------------------------------------------------------
// vi.mock — OSV client
// -----------------------------------------------------------------
//
// The dependency-cve scanner uses `createOsvClient()` internally. We mock the
// module so tests can observe whether OSV was called and script the response.
const osvBatchSpy = vi.fn();
const osvVulnSpy = vi.fn();

vi.mock('./scanners/osv-client.js', () => {
  class FakeOsvClientError extends Error {
    constructor(
      message: string,
      public readonly status?: number,
    ) {
      super(message);
      this.name = 'OsvClientError';
    }
  }
  return {
    OsvClientError: FakeOsvClientError,
    createOsvClient: () => ({
      queryBatch: (...args: unknown[]) => {
        if (onFirstOsvCall) {
          const cb = onFirstOsvCall;
          onFirstOsvCall = undefined;
          cb();
        }
        return osvBatchSpy(...args);
      },
      getVuln: (...args: unknown[]) => osvVulnSpy(...args),
    }),
  };
});

// -----------------------------------------------------------------
// Now the orchestrator import — `vi.mock` calls above have already swapped
// the dependency graph for this module.
// -----------------------------------------------------------------
import { runOrchestrator, type OrchestratorInput } from './orchestrator.js';
import { _clearRegisteredSecrets } from './util/secrets.js';
import { OsvClientError } from './scanners/osv-client.js';

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

/**
 * A diff with two files:
 *  - `src/auth.ts` — a regular .ts file containing a planted AWS access key on
 *    line 12 (the first reviewable line via the diff hunk header `@@ -10,0 +10,3 @@`).
 *  - `src/app.ts`  — a second regular .ts file the agent will comment on.
 *
 * Diff hunks are sized so the reviewable lines fall at deterministic spots:
 * see the assertions below. We hand-roll the unified diff so the test stays
 * independent of any fixture file.
 */
const PLANTED_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

function buildBaseDiff(): { diff: string; filesApi: OctokitState['filesApi'] } {
  // `src/auth.ts`: 3 added lines starting at line 10. The AWS key sits on the
  // SECOND added line, which is line 11 on HEAD.
  const authDiff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index 1111111..2222222 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -9,0 +10,3 @@',
    '+export const auth = {',
    `+  awsKey: "${PLANTED_AWS_KEY}",`,
    '+};',
  ].join('\n');

  // `src/app.ts`: 3 added lines starting at line 5.
  const appDiff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 3333333..4444444 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -4,0 +5,3 @@',
    '+export function app() {',
    '+  return 1;',
    '+}',
  ].join('\n');

  return {
    diff: `${authDiff}\n${appDiff}\n`,
    filesApi: [
      { filename: 'src/auth.ts', changes: 3, patch: authDiff },
      { filename: 'src/app.ts', changes: 3, patch: appDiff },
    ],
  };
}

/** Minimal pulls.get response shape. */
function makePullData(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: 'Test PR',
    body: '',
    user: { login: 'doug' },
    base: { sha: 'base000', ref: 'main' },
    head: { sha: 'head111', ref: 'feature' },
    labels: [],
    changed_files: 2,
    additions: 6,
    deletions: 0,
    draft: false,
    ...over,
  };
}

function baseInput(over: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    owner: 'driches',
    repo: 'test',
    pull_number: 1,
    anthropic_api_key: 'sk-ant-test',
    // OpenAI key empty by default — every pre-Task-5 test assumed
    // Anthropic-only and the fork-safety check only inspects the key for
    // the resolved provider.
    openai_api_key: '',
    github_token: 'ghs_test',
    config_path: '.vor.yml',
    dry_run: false,
    workspace_dir: '/tmp/workspace-does-not-exist',
    ...over,
  };
}

/**
 * Script a one-turn agent run that:
 *   - Calls `post_inline_comment` once with the given args.
 *   - Calls `post_summary` once.
 *   - Stops.
 *
 * The agent runner pushes the assistant blocks onto its conversation, then
 * iterates each tool_use sequentially. We bundle both calls into a single
 * turn so the SDK only needs to be called once per agent run.
 */
function scriptOneCommentAndSummary(
  commentInput: Record<string, unknown>,
  summaryInput: Record<string, unknown> = {
    strengths: ['Clear and focused changes that are easy to follow.'],
    assessment: 'comment',
    assessment_reasoning: 'Small observations; nothing blocking the merge here.',
  },
): void {
  agentScript.push({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'post_inline_comment',
        input: commentInput,
      },
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'post_summary',
        input: summaryInput,
      },
    ],
    stop_reason: 'tool_use',
  });
}

/** Script a one-turn agent run that ONLY posts a summary (no inline comments). */
function scriptSummaryOnly(
  summaryInput: Record<string, unknown> = {
    strengths: ['Clear and focused changes that are easy to follow.'],
    assessment: 'comment',
    assessment_reasoning: 'Small observations; nothing blocking the merge here.',
  },
): void {
  agentScript.push({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_summary',
        name: 'post_summary',
        input: summaryInput,
      },
    ],
    stop_reason: 'tool_use',
  });
}

// -----------------------------------------------------------------
// Shared per-test setup
// -----------------------------------------------------------------

beforeEach(() => {
  agentScript.length = 0;
  openaiScript.length = 0;
  openaiCtorCalls.length = 0;
  octokitState.diff = '';
  octokitState.filesApi = [];
  octokitState.pullData = makePullData();
  octokitState.contents = new Map();
  octokitState.priorReviews = [];
  octokitState.createReviewCalls = [];
  agentTurnGate = undefined;
  onFirstOsvCall = undefined;
  osvBatchSpy.mockReset();
  osvVulnSpy.mockReset();
});

afterEach(() => {
  // The secrets scanner registers raw matches in a process-global Set. Clean
  // up between tests so the redactor doesn't carry state forward.
  _clearRegisteredSecrets();
});

// -----------------------------------------------------------------
// Scenario 1: Happy path — AI + scanner both contribute to the review.
//
// Verifies the new parallel-merge logic (Task 8): the agent posts a comment,
// the secrets scanner posts a separate comment, both make it through the
// filter pipeline, and the formatter renders the "Security:" sub-line.
//
// Original spec called for a `package-lock.json` lodash CVE for the scanner
// finding. Lockfile findings are rejected by validate (is_generated=true), so
// we plant an AWS key in `src/auth.ts` — same orchestrator path, no validate
// wall. The dependency-cve assertion is exercised separately below.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 1: happy path with AI + scanner findings', () => {
  it('merges an AI comment and a scanner comment into a single review', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    // Disable dependency-cve so OSV isn't probed — secrets is enough to
    // generate a scanner finding for this scenario.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: false',
        '    secrets:',
        '      enabled: true',
        '      include_generic_entropy: false',
      ].join('\n'),
    );

    // The agent posts a single 'readability' finding on src/app.ts:5 plus a summary.
    scriptOneCommentAndSummary({
      severity: 'minor',
      file_path: 'src/app.ts',
      line: 5,
      side: 'RIGHT',
      category: 'readability',
      title: 'Function lacks return type annotation',
      why_it_matters: 'Explicit return types help future readers and TypeScript inference.',
      confidence: 'medium',
    });

    const result = await runOrchestrator(baseInput());

    // Review was posted exactly once.
    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
      body: string;
      event: string;
    };

    // Two comments — one AI, one scanner.
    expect(call.comments).toHaveLength(2);
    const paths = call.comments.map((c) => c.path).sort();
    expect(paths).toEqual(['src/app.ts', 'src/auth.ts']);

    // The scanner comment carries the `via secrets scan` provenance tag.
    const scannerComment = call.comments.find((c) => c.path === 'src/auth.ts')!;
    expect(scannerComment.body).toContain('via secrets scan');
    expect(scannerComment.body).toContain('AWS access key id');

    // The AI comment does NOT carry a provenance tag.
    const aiComment = call.comments.find((c) => c.path === 'src/app.ts')!;
    expect(aiComment.body).not.toMatch(/_via /);
    expect(aiComment.body).toContain('Function lacks return type annotation');

    // The review summary body advertises the security finding.
    expect(call.body).toContain('Security:');
    expect(call.body).toMatch(/1 secret/);

    // OSV was not called — dependency-cve disabled.
    expect(osvBatchSpy).not.toHaveBeenCalled();

    expect(result.comment_count).toBe(2);
    expect(result.dry_run).toBe(false);
    expect(result.review_id).toBe(12345);
  });
});

// -----------------------------------------------------------------
// Scenario 2: Cross-AI dedup suppresses an overlapping scanner finding.
//
// The agent posts a 'security' comment on src/auth.ts:10 (within 3 lines of
// the scanner-detected AWS key on line 11). Dedup pass 2 should drop the
// scanner finding because non-CVE scanner findings are suppressed by an
// overlapping AI security-adjacent comment.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 2: cross-AI dedup', () => {
  it('drops a non-CVE scanner finding when an AI security comment overlaps within 3 lines', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    // Disable dep-cve, leave secrets on.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: false',
        '    secrets:',
        '      enabled: true',
      ].join('\n'),
    );

    // Agent comments on line 10 of src/auth.ts (the const declaration). The
    // scanner will flag line 11 (the AWS key value). Distance = 1 → dedup
    // suppresses the scanner finding.
    scriptOneCommentAndSummary({
      severity: 'critical',
      file_path: 'src/auth.ts',
      line: 10,
      side: 'RIGHT',
      category: 'security',
      title: 'Hard-coded credentials in source',
      why_it_matters: 'Storing API keys in source code leaks them to anyone with repo access.',
      suggestion: 'export const auth = { awsKey: process.env.AWS_KEY };',
      confidence: 'high',
    });

    await runOrchestrator(baseInput());

    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
    };

    // Only the AI comment survives.
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0]!.body).toContain('Hard-coded credentials in source');
    expect(call.comments[0]!.body).not.toContain('via secrets scan');
  });
});

// -----------------------------------------------------------------
// Scenario 2a: SAME-LINE overlap (PR #12 regression).
//
// Reproduces the smoke-test PR #12 failure verbatim: the agent posts a
// 'security' comment ON THE SAME LINE as the scanner-detected AWS key
// (distance = 0, not 1). In production both shipped — two CRITICAL inline
// comments on the same line of the same file, one labeled `security` (AI)
// and one labeled `vulnerability · via secrets scan` (scanner). Dedup
// should suppress the scanner finding here just as it does in the
// distance-1 case (Scenario 2 above), but the smoke test proved it does not.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 2a: same-line overlap (PR #12 regression)', () => {
  it('drops the secrets scanner finding when the AI security comment sits on the same line (PR #12 regression)', async () => {
    // Faithful replay of smoke-test PR #12: a single file with TWO planted
    // bugs (AWS key on line 11, SQL injection on line 20). The agent posts
    // category='security' on BOTH lines. The secrets scanner produces one
    // finding (line 11, category='vulnerability'). Production posted three
    // comments — AI/security:11, AI/security:20, AND scanner/vulnerability:11
    // — so the scanner finding was NOT dedup-suppressed against the
    // co-located AI/security:11 comment. The expected behavior is two
    // comments (the two AI findings); the scanner finding on line 11 should
    // be suppressed because the AI's security-adjacent finding on the same
    // line takes precedence.
    const smokeDiff = [
      'diff --git a/examples/smoke-test-bad-code.ts b/examples/smoke-test-bad-code.ts',
      'index 0000000..1111111 100644',
      '--- a/examples/smoke-test-bad-code.ts',
      '+++ b/examples/smoke-test-bad-code.ts',
      '@@ -0,0 +1,22 @@',
      '+/**',
      '+ * Smoke-test fixture for the vor action.',
      '+ */',
      '+',
      '+// Bug 1: hardcoded credential.',
      '+',
      '+',
      '+',
      '+',
      '+',
      `+export const AWS_KEY = '${PLANTED_AWS_KEY}';`,
      '+',
      '+interface User {',
      '+  id: string;',
      '+  name: string;',
      '+}',
      '+',
      '+// Bug 2: SQL injection via template literal.',
      '+export async function getUser(db: { query: (sql: string) => Promise<User[]> }, userId: string): Promise<User | null> {',
      "+  const result = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);",
      '+  return result[0] ?? null;',
      '+}',
    ].join('\n');
    octokitState.diff = `${smokeDiff}\n`;
    octokitState.filesApi = [
      { filename: 'examples/smoke-test-bad-code.ts', changes: 22, patch: smokeDiff },
    ];
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: false',
        '    secrets:',
        '      enabled: true',
      ].join('\n'),
    );

    // CRITICAL: do NOT supply `side` in the AI tool input. The post-inline-
    // comment schema has `side: z.enum(['RIGHT','LEFT']).default('RIGHT')`,
    // but the agent runner forwards raw args to the handler without running
    // them through Zod, so the default never applies. Real agent runs that
    // omit `side` (most of them — RIGHT is the universal default) end up
    // with `side: undefined` on the in-memory PostedComment. The scanner
    // adapter hard-codes `side: 'RIGHT'`. The dedup overlap check then sees
    // `undefined !== 'RIGHT'` and fails to suppress the scanner. This test
    // replays PR #12's smoke-test scenario verbatim and pins the expected
    // dedup behavior. With the broken normalization it goes red.
    agentScript.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_aws',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'examples/smoke-test-bad-code.ts',
            line: 11,
            category: 'security',
            title: 'Hardcoded AWS access key ID',
            why_it_matters:
              'Committing an AKIA key in source leaks credentials to anyone with repo access; rotate immediately and load from a secret store.',
            suggestion: "export const AWS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';",
            confidence: 'high',
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    agentScript.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_sql',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'examples/smoke-test-bad-code.ts',
            line: 20,
            category: 'security',
            title: 'SQL injection via unsanitized template literal',
            why_it_matters:
              'Interpolating userId directly into the SQL string lets a caller alter the query — parameterize the value instead.',
            suggestion:
              "  const result = await db.query('SELECT * FROM users WHERE id = ?', [userId]);",
            confidence: 'high',
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    agentScript.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_summary',
          name: 'post_summary',
          input: {
            strengths: ['Clear and focused fixture.'],
            assessment: 'request_changes',
            assessment_reasoning: 'Two planted criticals detected.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    await runOrchestrator(baseInput());

    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string; line: number }>;
    };

    // The scanner finding on line 11 must be suppressed by the co-located AI
    // security comment. Two comments survive — the two AI findings.
    const scannerComments = call.comments.filter((c) =>
      c.body.includes('via secrets scan'),
    );
    expect(scannerComments).toHaveLength(0);
    expect(call.comments).toHaveLength(2);
    expect(call.comments.some((c) => c.body.includes('Hardcoded AWS access key ID'))).toBe(true);
    expect(call.comments.some((c) => c.body.includes('SQL injection'))).toBe(true);
  });
});

// -----------------------------------------------------------------
// Scenario 2b: Predicted-survivor dedup — an AI comment that won't ship MUST
// NOT suppress an overlapping scanner finding.
//
// Bug: the OLD ordering deduped scanner findings against the FULL
// `acceptedComments` list before the cap pass. So a low-severity AI comment
// that was about to be capped out could still "win" dedup, taking down a
// higher-severity scanner finding with it.
//
// Setup that exercises it: 3 AI 'security' comments on `src/auth.ts`. The
// per-file cap is 2, so the lowest-severity AI ('minor') gets dropped by the
// final filter. That minor sits on line 10 — overlapping the planted AWS key
// on line 11. The two surviving AIs ('important') sit on lines 5 and 7, both
// outside the 3-line overlap window for the scanner on line 11.
//
//   OLD: dedup scanner vs [imp5, imp7, min10] — overlap with min10 → SUPPRESSED.
//        filter([imp5, imp7, min10], per_file=2) → [imp5, imp7]. Scanner lost.
//
//   NEW: aiPredictedSurvivors = filter([imp5, imp7, min10], per_file=2) =
//        [imp5, imp7]. dedup scanner vs [imp5, imp7] — distances 6 and 4,
//        neither within window → scanner SURVIVES.
//        Final filter on [imp5, imp7, min10, scan11] (sorted critical desc):
//        [scan11(crit), imp5, imp7, min10]. per_file=2 → [scan11, imp5].
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 2b: AI comment dropped by cap does not suppress scanner', () => {
  it('keeps the scanner finding when the overlapping AI comment gets dropped by per-file cap', async () => {
    // Extend the base diff for src/auth.ts to cover more added lines so all
    // AI lines (5, 7) and the scanner line (11) are reviewable.
    const authDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -4,0 +5,8 @@',
      '+// auth module setup',
      '+',
      '+// auth helper goes here',
      '+',
      '+export const auth = {',
      '+  // misc comment',
      `+  awsKey: "${PLANTED_AWS_KEY}",`,
      '+};',
    ].join('\n');
    const appDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,3 @@',
      '+export function app() {',
      '+  return 1;',
      '+}',
    ].join('\n');
    octokitState.diff = `${authDiff}\n${appDiff}\n`;
    octokitState.filesApi = [
      { filename: 'src/auth.ts', changes: 8, patch: authDiff },
      { filename: 'src/app.ts', changes: 3, patch: appDiff },
    ];

    // per-file cap = 2 and 3 AI comments → the lowest-severity ('minor') one
    // is the one that loses. The two 'important' ones survive.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: false',
        '    secrets:',
        '      enabled: true',
        'severity:',
        '  floor: nit',
        '  max_comments_per_file: 2',
        '  max_comments_total: 30',
      ].join('\n'),
    );

    // Script three AI inline comments in a single turn, then a summary.
    // Critical/important comments REQUIRE a `suggestion` field (see
    // post-inline-comment.ts) — the suggestions below are non-empty stubs
    // that differ from the current line text so validation passes.
    agentScript.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'post_inline_comment',
          input: {
            severity: 'important',
            file_path: 'src/auth.ts',
            line: 5,
            side: 'RIGHT',
            category: 'security',
            title: 'Review auth module export shape',
            why_it_matters: 'Worth a second look at how the auth module is being constructed.',
            suggestion: '// Add an explicit summary header for the auth module',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_b',
          name: 'post_inline_comment',
          input: {
            severity: 'important',
            file_path: 'src/auth.ts',
            line: 7,
            side: 'RIGHT',
            category: 'security',
            title: 'Auth helper placement looks off',
            why_it_matters: 'Place this helper in a dedicated module to keep this file focused.',
            suggestion: '// Move the auth helper into src/auth/helper.ts',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_c',
          name: 'post_inline_comment',
          input: {
            severity: 'minor',
            file_path: 'src/auth.ts',
            line: 11,
            side: 'RIGHT',
            category: 'security',
            title: 'Document credential origin',
            why_it_matters: 'A brief note on where this credential should come from would help readers.',
            confidence: 'low',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_summary',
          name: 'post_summary',
          input: {
            strengths: ['Clear and focused changes that are easy to follow.'],
            assessment: 'comment',
            assessment_reasoning: 'A few observations.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    await runOrchestrator(baseInput());

    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
    };
    // Per-file cap=2 on src/auth.ts. With the fix:
    //   final filter sorts by severity desc → critical scanner first, then
    //   two important AIs, then minor. Cap=2 → keep scanner + one important.
    expect(call.comments).toHaveLength(2);
    // The scanner comment IS in the output (the whole point of this scenario).
    const scannerComment = call.comments.find((c) => c.body.includes('via secrets scan'));
    expect(scannerComment).toBeDefined();
    expect(scannerComment!.path).toBe('src/auth.ts');
    expect(scannerComment!.body).toContain('AWS access key id');
  });
});

// -----------------------------------------------------------------
// Scenario 2c: post-filter dedup — scanner survives when its overlapping AI
// counterpart is capped out by the combined cap. Regression for Codex P1 on
// PR #8.
//
// Bug being fixed: the OLD predict-then-dedup ran filterComments() over the
// AI-only list to compute "predicted survivors", deduped scanner findings
// against them, then added scanners to the aggregator. If an AI that was a
// predicted-survivor got bumped from the combined cap by scanner findings
// (sort-by-severity reshuffles the order), its scanner counterpart had
// ALREADY been deduped away. Net: nothing posts in the line area, security
// signal silently lost.
//
// Setup:
//   - 4 critical AI 'performance' comments on lines 5, 7, 9, 13 (not
//     security-adjacent, so dedup ignores them).
//   - 1 important AI 'security' comment on line 50 (security-adjacent).
//   - Scanner: critical 'secrets' finding on line 51 (within 3 lines of the
//     AI-50 security comment).
//   - per_file_cap = 5.
//
// OLD flow (predict-then-dedup):
//   - Predict survivors: filter(5 AI, cap=5) = all 5 (incl. AI-50).
//   - Dedup: scanner@51 distance=1 to AI-50 'security' → DROPPED.
//   - Combined: 5 AI (no scanner). All 5 fit cap=5. Posted: 4 critical AI +
//     important AI-50. Line 51 has NOTHING. ← bug
//
// NEW flow (post-filter dedup):
//   - All to aggregator: 5 AI + scanner = 6.
//   - filterComments(cap=5): sort severity desc — 5 critical (4 AI + scanner)
//     + 1 important (AI-50). Per-file cap=5 → keep first 5 critical: 4 AI +
//     scanner. AI-50 capped out.
//   - Post-filter dedup: surviving AI in kept list = 4 AI 'performance' on
//     lines 5/7/9/13. None are security-adjacent. Scanner stays.
//   - Posted: 4 critical AI + scanner. Line 51 HAS scanner finding. ← fix
//
// Assertions:
//   - Total kept comments = 5 (the cap).
//   - The scanner comment on src/auth.ts:51 IS in the posted review.
//   - The AI 'security' comment titled "Document credential origin" (line 50)
//     is NOT in the posted review.
//   - The 4 critical AI 'performance' comments ARE in the posted review.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 2c: scanner survives when capped-out AI would have suppressed it', () => {
  it('keeps the scanner finding after post-filter dedup when the overlapping AI gets capped', async () => {
    // Extended auth.ts diff: 47 added lines starting at line 5 so lines 5, 7,
    // 9, 13, 50, 51 are all reviewable. The planted AWS key sits on line 51.
    // We intersperse harmless filler so each commented line has reviewable
    // content and unique text (so dedup-on-title doesn't fire).
    const authLines: string[] = [];
    for (let i = 5; i <= 51; i += 1) {
      if (i === 5) authLines.push('+// auth module entry');
      else if (i === 7) authLines.push('+// auth helper init block');
      else if (i === 9) authLines.push('+// auth state container');
      else if (i === 13) authLines.push('+// auth wiring complete');
      else if (i === 50) authLines.push('+// credential block follows');
      else if (i === 51) authLines.push(`+const awsKey = "${PLANTED_AWS_KEY}";`);
      else authLines.push(`+// auth filler line ${i}`);
    }
    const addedCount = authLines.length; // 47
    const authDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      `@@ -4,0 +5,${addedCount} @@`,
      ...authLines,
    ].join('\n');
    const appDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,3 @@',
      '+export function app() {',
      '+  return 1;',
      '+}',
    ].join('\n');
    octokitState.diff = `${authDiff}\n${appDiff}\n`;
    octokitState.filesApi = [
      { filename: 'src/auth.ts', changes: addedCount, patch: authDiff },
      { filename: 'src/app.ts', changes: 3, patch: appDiff },
    ];

    // per-file cap = 5 so 4 critical AI + scanner fit; AI-50 (important) gets
    // pushed out by sort-by-severity-desc.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: false',
        '    secrets:',
        '      enabled: true',
        'severity:',
        '  floor: nit',
        '  max_comments_per_file: 5',
        '  max_comments_total: 30',
      ].join('\n'),
    );

    // 4 critical 'performance' AI comments on lines 5/7/9/13 + 1 important
    // 'security' AI on line 50 + a summary. critical and important require
    // `suggestion` per post-inline-comment.ts, so each carries a non-empty
    // suggestion that differs from the (filler) head line text.
    agentScript.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_p5',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'src/auth.ts',
            line: 5,
            side: 'RIGHT',
            category: 'performance',
            title: 'Hot-path entry pass-through',
            why_it_matters: 'This is the function entry; expensive work here ripples through every call.',
            suggestion: '+// Move expensive auth-module setup behind a lazy initializer',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_p7',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'src/auth.ts',
            line: 7,
            side: 'RIGHT',
            category: 'performance',
            title: 'Sync init block blocks request thread',
            why_it_matters: 'Synchronous init on the hot path adds latency to every auth check.',
            suggestion: '+// Move helper init to a one-shot async warmup',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_p9',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'src/auth.ts',
            line: 9,
            side: 'RIGHT',
            category: 'performance',
            title: 'State container allocation per call',
            why_it_matters: 'A new container per call adds GC pressure under load.',
            suggestion: '+// Reuse a single auth state container instance',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_p13',
          name: 'post_inline_comment',
          input: {
            severity: 'critical',
            file_path: 'src/auth.ts',
            line: 13,
            side: 'RIGHT',
            category: 'performance',
            title: 'Wiring step has a quadratic loop',
            why_it_matters: 'A nested scan over the wiring registry scales poorly as routes grow.',
            suggestion: '+// Replace the inner loop with a Map lookup',
            confidence: 'medium',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_sec50',
          name: 'post_inline_comment',
          input: {
            severity: 'important',
            file_path: 'src/auth.ts',
            line: 50,
            side: 'RIGHT',
            category: 'security',
            title: 'Document credential origin',
            why_it_matters: 'A brief note on where this credential should come from would help future readers audit the flow.',
            suggestion: '+// Source the credential from process.env.AWS_KEY',
            confidence: 'low',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_summary',
          name: 'post_summary',
          input: {
            strengths: ['Clear and focused changes that are easy to follow.'],
            assessment: 'comment',
            assessment_reasoning: 'A few observations.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    await runOrchestrator(baseInput());

    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string; line: number }>;
    };

    // Per-file cap=5 + sort-by-severity-desc: 4 critical AI + 1 critical
    // scanner survive; the important AI on line 50 gets dropped.
    expect(call.comments).toHaveLength(5);
    const authComments = call.comments.filter((c) => c.path === 'src/auth.ts');
    expect(authComments).toHaveLength(5);

    // The scanner comment IS in the output (the whole point of this scenario).
    const scannerComment = authComments.find((c) => c.body.includes('via secrets scan'));
    expect(scannerComment).toBeDefined();
    expect(scannerComment!.body).toContain('AWS access key id');
    // The secrets scanner posts at the line where the key was added (51).
    expect(scannerComment!.line).toBe(51);

    // The AI 'security' comment on line 50 was capped out, so it's NOT in the
    // posted review. Verify via title since line numbers might collide with
    // body rendering.
    const sec50 = authComments.find((c) => c.body.includes('Document credential origin'));
    expect(sec50).toBeUndefined();

    // The 4 critical performance AI comments survive.
    const perfTitles = [
      'Hot-path entry pass-through',
      'Sync init block blocks request thread',
      'State container allocation per call',
      'Wiring step has a quadratic loop',
    ];
    for (const t of perfTitles) {
      expect(authComments.some((c) => c.body.includes(t))).toBe(true);
    }
  });
});

// -----------------------------------------------------------------
// Scenario 3: dependency-cve happy path — lockfile CVE makes it into the review.
//
// The dep-cve scanner emits its finding against the lockfile, which is
// auto-classified as `is_generated: true` by the diff parser. Scanner findings
// are allowed on generated files (lockfiles are the canonical anchor for
// CVEs), so the comment survives validate and appears in the posted review
// with the `via OSV · <id>` provenance tag.
//
// Pretty-printed lockfile JSON is chosen so the parser's `findVersionLine`
// helper places the `lodash` version on a line that's actually inside the
// diff hunk (and therefore inside `reviewable_lines`).
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 3: dependency-cve happy path', () => {
  it('posts a scanner comment with the OSV provenance tag when a lockfile has a known CVE', async () => {
    // Pretty-printed lockfile so install key + version sit on separate lines.
    //
    //   line 1  {
    //   line 2    "name": "test",
    //   line 3    "version": "1.0.0",
    //   line 4    "lockfileVersion": 3,
    //   line 5    "packages": {
    //   line 6      "": {
    //   line 7        "name": "test",
    //   line 8        "version": "1.0.0"
    //   line 9      },
    //   line 10     "node_modules/lodash": {
    //   line 11       "version": "4.17.20"
    //   line 12     }
    //   line 13   }
    //   line 14 }
    //
    // `findVersionLine` scans for `"node_modules/lodash"` (line 10) and grabs
    // the next `"version":` (line 11). The diff hunk below covers lines 10–12,
    // so line 11 is reviewable.
    const lockContent = JSON.stringify(
      {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.20' },
        },
      },
      null,
      2,
    );

    const lockDiff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 5555555..6666666 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -9,0 +10,3 @@',
      '+    "node_modules/lodash": {',
      '+      "version": "4.17.20"',
      '+    }',
    ].join('\n');
    const appDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,1 @@',
      '+export const x = 1;',
    ].join('\n');
    octokitState.diff = `${lockDiff}\n${appDiff}\n`;
    octokitState.filesApi = [
      { filename: 'package-lock.json', changes: 3, patch: lockDiff },
      { filename: 'src/app.ts', changes: 1, patch: appDiff },
    ];
    octokitState.contents.set('package-lock.json', lockContent);

    // Enable dep-cve, disable secrets so we isolate the dep-cve trigger.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
        'exclude:',
        '  paths: []',
        '  max_diff_lines_per_file: 1500',
      ].join('\n'),
    );

    // OSV returns a hit for lodash, then a vuln record with CVSS 9.1.
    osvBatchSpy.mockResolvedValue({
      results: [{ vulns: [{ id: 'GHSA-jf85-cpcp-j695', modified: '2024-01-01T00:00:00Z' }] }],
    });
    osvVulnSpy.mockResolvedValue({
      id: 'GHSA-jf85-cpcp-j695',
      aliases: ['CVE-2019-10744'],
      summary: 'Prototype Pollution in lodash',
      severity: [{ type: 'CVSS_V3', score: '9.1' }],
      affected: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.12' }] }],
        },
      ],
    });

    scriptSummaryOnly();

    await runOrchestrator(baseInput());

    // OSV WAS called — proves the parallel runner reached dep-cve.
    expect(osvBatchSpy).toHaveBeenCalledTimes(1);
    // getVuln signature: (id, opts?) — opts carries the AbortSignal the
    // runner threads through for cancellation. Don't pin the exact opts
    // shape, just confirm the id we expect.
    expect(osvVulnSpy).toHaveBeenCalledWith(
      'GHSA-jf85-cpcp-j695',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // The scanner comment now makes it into the review.
    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
      body: string;
    };
    expect(call.comments).toHaveLength(1);
    const lockComment = call.comments[0]!;
    expect(lockComment.path).toBe('package-lock.json');
    // Provenance tag is rendered with the OSV id.
    expect(lockComment.body).toContain('via OSV');
    expect(lockComment.body).toContain('GHSA-jf85-cpcp-j695');
    // Body advertises the security finding count.
    expect(call.body).toContain('Security:');
  });
});

// -----------------------------------------------------------------
// Scenario 4: Scanner error doesn't block the AI review.
//
// The runner is error-isolated — any throw from a scanner is converted into a
// non-fatal ScanError that ends up in `errors[]` on the result. The agent
// finishes normally and its findings still get posted.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 4: scanner error does not block AI review', () => {
  it('posts the AI review when OSV throws OsvClientError', async () => {
    // Diff with a lockfile so dep-cve attempts OSV.
    const lockDiff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 5555555..6666666 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -5,0 +6,4 @@',
      '+    "node_modules/lodash": {',
      '+      "version": "4.17.20",',
      '+      "resolved": "https://example/lodash-4.17.20.tgz"',
      '+    },',
    ].join('\n');
    const appDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,1 @@',
      '+export const x = 1;',
    ].join('\n');
    octokitState.diff = `${lockDiff}\n${appDiff}\n`;
    octokitState.filesApi = [
      { filename: 'package-lock.json', changes: 4, patch: lockDiff },
      { filename: 'src/app.ts', changes: 1, patch: appDiff },
    ];

    // Multi-line lockfile so the parser's anchored line for lodash falls
    // inside the diff's added-line range (the diff @@ -5,0 +6,4 @@ adds
    // lines 6-9; the version sits at line 7).
    octokitState.contents.set(
      'package-lock.json',
      [
        '{',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": { "name": "app", "version": "1.0.0" },',
        '    "node_modules/other": { "version": "2.0.0" },',
        '    "node_modules/lodash": {',
        '      "version": "4.17.20"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
        'exclude:',
        '  paths: []',
        '  max_diff_lines_per_file: 1500',
      ].join('\n'),
    );

    osvBatchSpy.mockRejectedValue(new OsvClientError('OSV unavailable', 503));

    scriptOneCommentAndSummary({
      severity: 'minor',
      file_path: 'src/app.ts',
      line: 5,
      side: 'RIGHT',
      category: 'readability',
      title: 'Could use a more descriptive name',
      why_it_matters: 'Single-letter exports are hard to grep for in larger codebases.',
      confidence: 'medium',
    });

    const result = await runOrchestrator(baseInput());

    expect(osvBatchSpy).toHaveBeenCalledTimes(1);
    expect(octokitState.createReviewCalls).toHaveLength(1);

    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
    };
    // The AI comment IS in the review. No scanner comment (CVE rejected by validate).
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0]!.path).toBe('src/app.ts');
    expect(result.comment_count).toBe(1);
  });
});

// -----------------------------------------------------------------
// Bonus: prove the agent and the scanners run concurrently.
//
// Strategy: gate the agent's first `messages.create` on a deferred promise
// that we only resolve once OSV.queryBatch has actually been invoked. If the
// orchestrator were sequential (scanner-then-agent or agent-then-scanner) the
// run would deadlock: scanner waits on OSV (which fires immediately) but agent
// is suspended on a promise that only the scanner can resolve. Both must
// progress concurrently for the test to terminate.
// -----------------------------------------------------------------

describe('runOrchestrator — parallel execution of agent and scanners', () => {
  it('progresses the agent and the scanner concurrently (Promise.all path)', async () => {
    const lockDiff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 5555555..6666666 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -5,0 +6,3 @@',
      '+    "node_modules/lodash": {',
      '+      "version": "4.17.20"',
      '+    },',
    ].join('\n');
    const appDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 3333333..4444444 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,0 +5,1 @@',
      '+export const x = 1;',
    ].join('\n');
    octokitState.diff = `${lockDiff}\n${appDiff}\n`;
    octokitState.filesApi = [
      { filename: 'package-lock.json', changes: 3, patch: lockDiff },
      { filename: 'src/app.ts', changes: 1, patch: appDiff },
    ];
    // Multi-line so the lodash version line aligns with the diff's added-line
    // range (@@ -5,0 +6,3 @@ adds lines 6-8).
    octokitState.contents.set(
      'package-lock.json',
      [
        '{',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": { "name": "app", "version": "1.0.0" },',
        '    "node_modules/other": { "version": "2.0.0" },',
        '    "node_modules/lodash": {',
        '      "version": "4.17.20"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
        'exclude:',
        '  paths: []',
        '  max_diff_lines_per_file: 1500',
      ].join('\n'),
    );

    // Install the gate. The agent's `messages.create` will await this promise
    // before returning. The scanner's first OSV call resolves it.
    let release!: () => void;
    agentTurnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onFirstOsvCall = () => release();

    // Script a minimal agent run — just post a summary after the gate opens.
    scriptSummaryOnly();

    // OSV resolves with no vulns so we don't have to script getVuln.
    osvBatchSpy.mockResolvedValue({ results: [{}] });

    await runOrchestrator(baseInput());

    // If we got here without a timeout, scanner and agent overlapped: the
    // scanner had to fire OSV (releasing the gate) BEFORE the agent could
    // make any progress. This proves they aren't strictly sequential.
    expect(osvBatchSpy).toHaveBeenCalledTimes(1);
    expect(octokitState.createReviewCalls).toHaveLength(1);
  });
});

// -----------------------------------------------------------------
// Scenario 4b: agent rejection aborts the in-flight scanner signal.
//
// Bug: `orchestratorAbort.abort()` used to run AFTER `await Promise.allSettled`,
// at which point the scanner branch had already settled (or hit its own
// per-scanner timeout). The abort couldn't actually cancel in-flight scanner
// work. The fix attaches `.catch()` directly to the agent promise so abort
// fires synchronously on agent rejection, well before the allSettled tuple
// resolves.
//
// Strategy: hang the OSV batch call inside a long-running promise that
// captures the signal and only resolves when the signal aborts. Make the
// agent reject (no scripted turn → SDK mock throws 'agentScript exhausted').
// Assert the captured signal is `.aborted === true` — proving the abort
// fired while the scanner was still in flight.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 4b: agent rejection aborts the scanner signal in-flight', () => {
  it('aborts the scanner deps.signal when the agent throws (no waiting for the per-scanner timeout)', async () => {
    // Lockfile so dep-cve actually runs and OSV is invoked.
    const lockDiff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 5555555..6666666 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -5,0 +6,3 @@',
      '+    "node_modules/lodash": {',
      '+      "version": "4.17.20"',
      '+    },',
    ].join('\n');
    octokitState.diff = `${lockDiff}\n`;
    octokitState.filesApi = [
      { filename: 'package-lock.json', changes: 3, patch: lockDiff },
    ];
    octokitState.contents.set(
      'package-lock.json',
      [
        '{',
        '  "lockfileVersion": 3,',
        '  "packages": {',
        '    "": { "name": "app", "version": "1.0.0" },',
        '    "node_modules/other": { "version": "2.0.0" },',
        '    "node_modules/lodash": {',
        '      "version": "4.17.20"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
        'exclude:',
        '  paths: []',
        '  max_diff_lines_per_file: 1500',
      ].join('\n'),
    );

    // OSV's queryBatch captures the signal it receives and waits on its
    // abort. If the orchestrator's abort actually fires while we're still
    // in-flight, the promise resolves; otherwise this hangs until the
    // per-scanner timeout, the test times out, and we know the fix is gone.
    let capturedSignal: AbortSignal | undefined;
    osvBatchSpy.mockImplementation(async (_queries: unknown, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      // Wait for the signal to abort, then resolve with an empty result so
      // the scanner branch can finish settling. We don't reject here because
      // the runner's `Promise.race` against `abortPromise` would settle on
      // the race side anyway — this branch just unblocks for a tidy exit.
      await new Promise<void>((resolve) => {
        if (capturedSignal?.aborted) {
          resolve();
          return;
        }
        capturedSignal?.addEventListener(
          'abort',
          () => resolve(),
          { once: true },
        );
      });
      return { results: [{}] };
    });

    // Don't script any agent turn — the SDK mock will throw "agentScript
    // exhausted", which propagates as the agent rejection.
    agentScript.length = 0;

    // The orchestrator re-throws the agent error. We catch and assert the
    // scanner signal observed the abort while it was still in flight.
    await expect(runOrchestrator(baseInput())).rejects.toThrow(/exhausted/);

    // The scanner saw a signal. Critical assertion: it was aborted before
    // the runScanners branch fulfilled — meaning the orchestrator-level
    // abort fired BEFORE allSettled resolved (otherwise our hang above
    // would never have released).
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });
});

// -----------------------------------------------------------------
// Scenario 5: `security.enabled: false` short-circuits the scanner pipeline.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 5: security.enabled=false skips all scanners', () => {
  it('does not invoke OSV and includes no scanner comments in the review', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    // Same diff as Scenario 1 — would normally trigger secrets — but the
    // master switch is off.
    octokitState.contents.set(
      '.vor.yml',
      [
        'security:',
        '  enabled: false',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: true',
      ].join('\n'),
    );

    scriptOneCommentAndSummary({
      severity: 'minor',
      file_path: 'src/app.ts',
      line: 5,
      side: 'RIGHT',
      category: 'readability',
      title: 'Could use a more descriptive name',
      why_it_matters: 'Single-letter exports are hard to grep for in larger codebases.',
      confidence: 'medium',
    });

    const result = await runOrchestrator(baseInput());

    // OSV NEVER called.
    expect(osvBatchSpy).not.toHaveBeenCalled();

    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ path: string; body: string }>;
      body: string;
    };
    // Just the AI comment — no scanner-sourced comment despite the planted
    // AWS key in src/auth.ts (secrets scanner did not run).
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0]!.path).toBe('src/app.ts');
    expect(call.body).not.toContain('Security:');
    expect(result.comment_count).toBe(1);
  });
});

// -----------------------------------------------------------------
// Scenario 6: Fork-PR safety — no Anthropic key with the default
// claude-sonnet-4-6 model short-circuits before the agent runs.
//
// This is the moved-from-index.ts fork-safety check. The orchestrator must
// not throw, must not invoke runAgent (no Anthropic SDK call), and must
// return ended='skipped_no_key_anthropic' so telemetry can distinguish from
// 'skipped_draft'.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 6: fork-safety on missing Anthropic key', () => {
  it('skips cleanly when anthropic_api_key is empty and the resolved provider is Anthropic', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    // No config file → loader returns DEFAULT_CONFIG → model claude-sonnet-4-6
    // → inferProviderFromModel('claude-sonnet-4-6') → 'anthropic'.

    const result = await runOrchestrator(
      baseInput({ anthropic_api_key: '', openai_api_key: '' }),
    );

    expect(result.ended).toBe('skipped_no_key_anthropic');
    expect(result.comment_count).toBe(0);
    expect(result.cost_usd).toBe(0);
    // No review was posted (the orchestrator returned before postReview).
    expect(octokitState.createReviewCalls).toHaveLength(0);
    // Agent was never invoked — the Anthropic SDK mock's createSpy stays at 0.
    expect(agentScript.length).toBe(0); // unchanged from beforeEach reset
  });
});

// -----------------------------------------------------------------
// Scenario 7: OpenAI fork-safety — Anthropic key present, OpenAI key absent,
// config selects an OpenAI model. The orchestrator must pick OpenAI based on
// model inference, see no OPENAI key, and skip with ended='skipped_no_key_openai'.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 7: fork-safety on missing OpenAI key', () => {
  it('skips cleanly when the config selects an OpenAI model and openai_api_key is empty', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    octokitState.contents.set(
      '.vor.yml',
      [
        'model: gpt-4.1',
        'security:',
        '  enabled: false',
      ].join('\n'),
    );

    const result = await runOrchestrator(
      baseInput({ anthropic_api_key: 'sk-ant-test', openai_api_key: '' }),
    );

    expect(result.ended).toBe('skipped_no_key_openai');
    expect(result.comment_count).toBe(0);
    expect(octokitState.createReviewCalls).toHaveLength(0);
    // OpenAI SDK was never instantiated — orchestrator short-circuited before
    // createProvider() ran.
    expect(openaiCtorCalls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------
// Scenario 8: OpenAI happy path — config picks gpt-4.1, openai_api_key is
// supplied. The orchestrator resolves provider=openai, instantiates the
// OpenAI SDK with the OpenAI key (NOT the Anthropic one), drives the agent
// through one summary turn, and posts the review.
//
// Key assertions:
//   - The OpenAI SDK constructor saw `openai_api_key`, NOT `anthropic_api_key`.
//   - `responses.create` was called (proving we routed through the OpenAI
//     provider, not the Anthropic one).
//   - The review was posted successfully.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 8: OpenAI happy path', () => {
  it('routes through the OpenAI provider when config selects a GPT model and the key is present', async () => {
    const base = buildBaseDiff();
    octokitState.diff = base.diff;
    octokitState.filesApi = base.filesApi;
    octokitState.contents.set(
      '.vor.yml',
      [
        'model: gpt-4.1',
        'security:',
        '  enabled: false', // keep the test focused on the LLM path
      ].join('\n'),
    );

    // One OpenAI turn: function_call for post_summary, then completion. The
    // runner sees stop_reason='tool_calls' (mapped from function_call output),
    // executes the summary tool, and then `aggregator.hasSummary()` ends the
    // loop.
    openaiScript.push({
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'post_summary',
          arguments: JSON.stringify({
            strengths: ['Clear and focused changes that are easy to follow.'],
            assessment: 'comment',
            assessment_reasoning: 'Small observations; nothing blocking the merge here.',
          }),
        },
      ],
      status: 'completed',
    });

    const result = await runOrchestrator(
      baseInput({
        anthropic_api_key: 'sk-ant-test-NOT-USED',
        openai_api_key: 'sk-openai-test',
      }),
    );

    // OpenAI SDK was constructed exactly once, with the OPENAI key.
    expect(openaiCtorCalls).toHaveLength(1);
    expect(openaiCtorCalls[0]!.apiKey).toBe('sk-openai-test');
    // Sanity: the Anthropic key was NOT what we handed to OpenAI.
    expect(openaiCtorCalls[0]!.apiKey).not.toBe('sk-ant-test-NOT-USED');

    // The review was posted (proves the agent reached summary_posted via the
    // OpenAI path).
    expect(octokitState.createReviewCalls).toHaveLength(1);
    expect(result.ended).toBe('summary_posted');
  });
});

// Scenario 9: provider_override is runtime-validated before any side effects.
// Codex P2 #3300632002 — a typo'd INPUT_PROVIDER (cast to ProviderId in
// index.ts without runtime guard) used to silently flow through to the
// missing-key short-circuit and emit `ended: skipped_no_key_<typo>`. The
// orchestrator now throws at entry, surfacing as setFailed in CI.
describe('runOrchestrator — Scenario 9: provider_override runtime validation', () => {
  it('throws on an unknown provider_override string (no API calls, no skip)', async () => {
    const input = baseInput({
      // Cast through unknown to bypass the TS ProviderId type — simulates
      // what `process.env.INPUT_PROVIDER?.trim() as ProviderId | undefined`
      // produces when the operator typoes the value.
      provider_override: 'open-ai' as unknown as 'anthropic' | 'openai',
    });

    await expect(runOrchestrator(input)).rejects.toThrow(/Invalid provider_override "open-ai"/);
  });

  it('accepts "anthropic" and "openai" without error', async () => {
    // Sanity guards: don't regress the valid path. We don't run the full
    // orchestrator (would need agent mocks); just confirm the validation
    // doesn't throw on the two valid values. The fork-safety check still
    // fires because the keys are empty, but that's an `ended: skipped_no_key_*`
    // outcome — not a thrown error.
    const input = baseInput({
      provider_override: 'anthropic',
      anthropic_api_key: '',
    });
    const result = await runOrchestrator(input);
    expect(result.ended).toBe('skipped_no_key_anthropic');

    const input2 = baseInput({
      provider_override: 'openai',
      anthropic_api_key: '',
      openai_api_key: '',
    });
    const result2 = await runOrchestrator(input2);
    expect(result2.ended).toBe('skipped_no_key_openai');
  });
});
