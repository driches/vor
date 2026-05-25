import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { Budget } from '../util/budget.js';
import { BudgetError } from '../util/errors.js';
import type { PRContext } from '../github/pr-context.js';
import { renderPreflightSection, runPreflight, type PreflightAnalysis } from './preflight.js';

interface FakeAnthropic {
  messages: {
    create: ReturnType<typeof vi.fn>;
  };
}

function makeBudget(): Budget {
  return new Budget({
    maxTurns: 10,
    warnFraction: 0.8,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 50_000,
  });
}

function makeContext(): PRContext {
  return {
    metadata: {
      number: 1,
      title: 'Test PR',
      body: 'Body text',
      author: 'tester',
      base_sha: 'b'.repeat(40),
      head_sha: 'h'.repeat(40),
      base_ref: 'main',
      head_ref: 'feature',
      labels: [],
      changed_file_count: 1,
      additions: 5,
      deletions: 1,
      draft: false,
    },
    files: [
      {
        path: 'src/foo.ts',
        status: 'modified',
        additions: 5,
        deletions: 1,
        reviewable_lines: [[10, 15]],
        added_lines: new Set([10, 11, 12, 13, 14, 15]),
        language: 'typescript',
        is_generated: false,
        is_binary: false,
        size_bytes: 200,
        head_line_text: new Map(),
      },
    ],
    diff: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n',
  };
}

function mockResponse(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text' as const, text, citations: [] }] as Anthropic.ContentBlock[],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      service_tier: 'standard',
      server_tool_use: null,
    } as unknown as Anthropic.Message['usage'],
  };
}

describe('runPreflight', () => {
  it('parses a structured Haiku response into PreflightAnalysis', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse(
            JSON.stringify({
              candidates: [
                {
                  file: 'src/foo.ts',
                  line_range: '10-15',
                  severity_guess: 'important',
                  category: 'bug',
                  what: 'Missing null check',
                  why: 'May throw on undefined input.',
                },
              ],
              low_risk_files: ['package-lock.json'],
              global_observations: ['New dependency added.'],
            }),
          ),
        ),
      },
    };
    const analysis = await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget: makeBudget(),
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    expect(analysis).not.toBeNull();
    expect(analysis!.candidates).toHaveLength(1);
    expect(analysis!.candidates[0]!.severity_guess).toBe('important');
    expect(analysis!.low_risk_files).toContain('package-lock.json');
  });

  it('returns null when Haiku produces invalid JSON (caller continues without preflight)', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () => mockResponse('not valid json')),
      },
    };
    const analysis = await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget: makeBudget(),
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    expect(analysis).toBeNull();
  });

  it('returns null when JSON parses but fails schema (caller continues without preflight)', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse(
            JSON.stringify({
              candidates: [{ file: 'x', line_range: '1', severity_guess: 'BOGUS_SEV', category: 'bug', what: 'x', why: 'x' }],
            }),
          ),
        ),
      },
    };
    const analysis = await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget: makeBudget(),
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    expect(analysis).toBeNull();
  });

  it('returns null when the API call itself throws (network / 5xx — recoverable)', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('connection refused');
        }),
      },
    };
    const analysis = await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget: makeBudget(),
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    expect(analysis).toBeNull();
  });

  it('propagates BudgetError instead of swallowing it (same rule as the worker tool)', async () => {
    const tightBudget = new Budget({
      maxTurns: 10,
      warnFraction: 0.8,
      maxInputTokens: 50,
      maxOutputTokens: 50,
    });
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse(JSON.stringify({ candidates: [] })),
        ),
      },
    };
    // Response usage of 1000 input tokens blows past the 50-token cap.
    await expect(
      runPreflight({
        client: fakeClient as unknown as Anthropic,
        budget: tightBudget,
        model: 'claude-haiku-4-5',
        prContext: makeContext(),
      }),
    ).rejects.toBeInstanceOf(BudgetError);
  });

  it('strips ```json fences from Haiku output', async () => {
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse(
            '```json\n' +
              JSON.stringify({ candidates: [], low_risk_files: [], global_observations: [] }) +
              '\n```',
          ),
        ),
      },
    };
    const analysis = await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget: makeBudget(),
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    expect(analysis).not.toBeNull();
    expect(analysis!.candidates).toHaveLength(0);
  });

  it('records Haiku usage against the shared budget under the worker model id', async () => {
    const budget = makeBudget();
    const fakeClient: FakeAnthropic = {
      messages: {
        create: vi.fn(async () =>
          mockResponse(JSON.stringify({ candidates: [], low_risk_files: [], global_observations: [] })),
        ),
      },
    };
    await runPreflight({
      client: fakeClient as unknown as Anthropic,
      budget,
      model: 'claude-haiku-4-5',
      prContext: makeContext(),
    });
    const perModel = budget.snapshotByModel();
    expect(perModel).toHaveLength(1);
    expect(perModel[0]!.model).toBe('claude-haiku-4-5');
    expect(perModel[0]!.usage.inputTokens).toBe(1000);
  });
});

describe('renderPreflightSection', () => {
  const analysis: PreflightAnalysis = {
    candidates: [
      {
        file: 'src/foo.ts',
        line_range: '10-15',
        severity_guess: 'important',
        category: 'bug',
        what: 'Missing null check',
        why: 'May throw on undefined input.',
      },
    ],
    low_risk_files: ['package-lock.json'],
    global_observations: ['New dep added.'],
  };

  const changedFiles = [
    { path: 'src/foo.ts', status: 'modified', additions: 5, deletions: 1 },
    { path: 'src/bar.ts', status: 'modified', additions: 3, deletions: 0 },
    { path: 'package-lock.json', status: 'modified', additions: 50, deletions: 30 },
  ];

  it('renders a candidate with file:lines, severity, and reasoning', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toContain('src/foo.ts:10-15');
    expect(out).toContain('IMPORTANT');
    expect(out).toContain('Missing null check');
    expect(out).toContain('May throw on undefined input.');
  });

  it('renders EVERY changed file (not just candidates) so unflagged files still get investigated', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('src/bar.ts');
    expect(out).toContain('package-lock.json');
    // src/bar.ts has no candidate → must be annotated so it still appears
    expect(out).toMatch(/src\/bar\.ts.*no candidates/);
  });

  it('annotates flagged files with their candidate count', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toMatch(/src\/foo\.ts.*1 candidate/);
  });

  it('annotates low-risk files (still flagged for verify-before-skip)', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toMatch(/package-lock\.json.*low-risk/);
  });

  it('renders global observations when present', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toContain('Global observations');
    expect(out).toContain('New dep added.');
  });

  it('emits a "no candidates across any file" notice when nothing flagged', () => {
    const empty: PreflightAnalysis = {
      candidates: [],
      low_risk_files: [],
      global_observations: [],
    };
    const out = renderPreflightSection(empty, changedFiles);
    expect(out).toContain('No candidates flagged across any file');
    // All files should still be listed so Sonnet investigates each.
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('src/bar.ts');
  });

  it('framing is advisory, not authoritative — explicit "verify independently" + "absence-from-list" language', () => {
    const out = renderPreflightSection(analysis, changedFiles);
    expect(out).toMatch(/verify independently/i);
    expect(out).toMatch(/absence-from-the-list|absence from the list/i);
  });
});
