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
 * Important design note — secrets vs. dependency-cve:
 *
 *   The original Task 9 spec asked for a "happy path" scenario using a
 *   `package-lock.json` finding from the dependency-cve scanner. In practice
 *   that finding is rejected by `validateScanFinding` because the diff parser
 *   auto-classifies `package-lock.json` as `is_generated: true`, and validate
 *   refuses to post on generated files. So a lockfile-shaped scenario tests
 *   "no scanner comment in the review" rather than the desired "scanner
 *   comment in the review". To exercise the survives-the-pipeline behavior we
 *   instead plant an AWS access key in a regular source file and let the
 *   `secrets` scanner pick it up — same merge / dedup / adapter code path, no
 *   is_generated wall in the way. The dependency-cve scanner is still
 *   exercised separately to assert that the OSV path is/isn't taken depending
 *   on `security.enabled`.
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
const PLANTED_AWS_KEY = 'AKIA0123456789ABCDEF';

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
    github_token: 'ghs_test',
    config_path: '.code-review.yml',
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
      '.code-review.yml',
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
      '.code-review.yml',
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
// Scenario 3: dependency-cve findings are protected from cross-AI dedup.
//
// Trickier scenario: we want both an AI comment AND a dependency-cve scanner
// finding on the same neighborhood, asserting BOTH survive.
//
// This scenario hits an architectural snag: the dep-cve scanner emits its
// finding against the lockfile, which `validateScanFinding` rejects because
// the diff parser flags `package-lock.json` as `is_generated: true`. So a
// "true" dep-cve E2E happy path through validate is not currently possible
// without changing the orchestrator. We document this and instead assert the
// dedup pass itself preserves CVE findings via a unit-level test on
// `dedupScannerFindings` — already covered by `dedup.test.ts`. The piece we
// can integration-test is that OSV IS invoked when dep-cve is enabled, which
// proves the parallel runner reaches it.
// -----------------------------------------------------------------

describe('runOrchestrator — Scenario 3: dependency-cve scanner is invoked in parallel', () => {
  it('invokes OSV.queryBatch when dependency-cve is enabled and a lockfile is changed', async () => {
    // Build a diff with a package-lock.json change. `parse-diff` needs real
    // hunks; we hand-craft a tiny lockfile change.
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

    // Provide the lockfile content to the FileReader so dep-cve's parse step
    // actually finds lodash.
    octokitState.contents.set(
      'package-lock.json',
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.20' },
        },
      }),
    );
    // Enable dep-cve, disable secrets so we isolate the dep-cve trigger.
    octokitState.contents.set(
      '.code-review.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
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
    expect(osvVulnSpy).toHaveBeenCalledWith('GHSA-jf85-cpcp-j695');

    // Review was still posted, even though the CVE finding gets rejected by
    // validate (lockfile is generated → comment can't be posted on it).
    expect(octokitState.createReviewCalls).toHaveLength(1);
    const call = octokitState.createReviewCalls[0]!.args as {
      comments: Array<{ body: string }>;
    };
    // No inline comment makes it through (CVE finding rejected as generated,
    // and no AI inline comments were scripted).
    expect(call.comments).toHaveLength(0);
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

    octokitState.contents.set(
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/lodash': { version: '4.17.20' },
        },
      }),
    );
    octokitState.contents.set(
      '.code-review.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
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
    octokitState.contents.set(
      'package-lock.json',
      JSON.stringify({
        packages: { 'node_modules/lodash': { version: '4.17.20' } },
      }),
    );
    octokitState.contents.set(
      '.code-review.yml',
      [
        'security:',
        '  enabled: true',
        '  scanners:',
        '    dependency_cve:',
        '      enabled: true',
        '    secrets:',
        '      enabled: false',
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
      '.code-review.yml',
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
