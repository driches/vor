import { describe, expect, it } from 'vitest';
import { makePostInlineCommentTool, normalizeSuggestion } from './post-inline-comment.js';
import { buildFakeDeps, callTool, getResultJson, makeFile } from './test-helpers.js';

describe('post_inline_comment tool', () => {
  it('accepts a valid critical comment with suggestion', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'critical',
      file_path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT',
      category: 'bug',
      title: 'Off by one in loop',
      why_it_matters: 'Causes out-of-bounds read on the last iteration.',
      suggestion: 'for (let i = 0; i < arr.length; i++)',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.acceptedComments).toHaveLength(1);
    expect(deps.aggregator.acceptedComments[0]!.severity).toBe('critical');
  });

  it('rejects critical without suggestion', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'critical',
      file_path: 'src/foo.ts',
      line: 10,
      side: 'RIGHT',
      category: 'bug',
      title: 'Bug here',
      why_it_matters: 'It will crash on certain inputs and lose user data.',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('requires a suggestion');
  });

  it('rejects comment on line outside reviewable range', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 50,
      side: 'RIGHT',
      category: 'readability',
      title: 'Some minor thing',
      why_it_matters: 'Could be clearer in how it names the variable.',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean; reason: string; hint: string };
    expect(json.accepted).toBe(false);
    expect(json.hint).toContain('10-15');
  });

  it('rejects unknown file_path with nearest-match hint', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/bar.ts',
      line: 10,
      side: 'RIGHT',
      category: 'bug',
      title: 'A clear title',
      why_it_matters: 'Reason for this finding goes here.',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean; hint: string };
    expect(json.accepted).toBe(false);
    expect(json.hint).toContain('src/foo.ts');
  });

  it('rejects start_line >= line', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 10,
      start_line: 10,
      side: 'RIGHT',
      category: 'readability',
      title: 'A clear title',
      why_it_matters: 'Reason for this finding goes here.',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('start_line');
  });

  it('defaults `side` to RIGHT and `confidence` to high when omitted (PR #12 regression)', async () => {
    // The Zod schema declares `.default('RIGHT')` for side and
    // `.default('high')` for confidence. The `tool()` helper parses raw tool
    // input through the schema before this handler runs, so those defaults
    // fire and the in-memory PostedComment carries concrete values. If `side`
    // landed as undefined, the post-filter scanner-vs-AI dedup would fail its
    // `ai.side === c.side` check (the scanner adapter hard-codes 'RIGHT'), and
    // a scanner finding co-located with an AI security comment would ship as a
    // duplicate. PR #12 and PR #16 smoke tests both reproduced exactly this.
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 10,
      category: 'readability',
      title: 'A reasonably descriptive title',
      why_it_matters: 'A short rationale that makes future readers care.',
    });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.acceptedComments).toHaveLength(1);
    const stored = deps.aggregator.acceptedComments[0]!;
    expect(stored.side).toBe('RIGHT');
    expect(stored.confidence).toBe('high');
  });

  it('rejects an out-of-enum `side`/`confidence` at the schema boundary', async () => {
    // The `tool()` helper parses raw tool input through the Zod schema before
    // the handler runs, so an out-of-enum value (e.g. lowercase 'left' or an
    // unknown confidence) is rejected rather than cast through unchecked. The
    // throw is surfaced to the agent as a tool error so it can self-correct;
    // no malformed value lands in the aggregator.
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    await expect(
      callTool(tool, {
        severity: 'minor',
        file_path: 'src/foo.ts',
        line: 10,
        side: 'left',
        category: 'readability',
        title: 'A reasonably descriptive title',
        why_it_matters: 'A short rationale that makes future readers care.',
        confidence: 'maybe',
      } as unknown as Parameters<typeof callTool>[1]),
    ).rejects.toThrow(/Invalid arguments for post_inline_comment/);
    expect(deps.aggregator.acceptedComments).toHaveLength(0);
  });

  it('preserves valid `side: LEFT` and `confidence: medium` when explicitly provided', async () => {
    // Pins the pass-through of a valid non-default enum value: LEFT/medium
    // must survive the schema parse unchanged and reach the aggregator as-is.
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 10,
      side: 'LEFT',
      category: 'readability',
      title: 'A reasonably descriptive title',
      why_it_matters: 'A short rationale that makes future readers care.',
      confidence: 'medium',
    });
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    const stored = deps.aggregator.acceptedComments[0]!;
    expect(stored.side).toBe('LEFT');
    expect(stored.confidence).toBe('medium');
  });

  it('strips an accidental outer ```suggestion fence from suggestion input', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'important',
      file_path: 'src/foo.ts',
      line: 10,
      category: 'bug',
      title: 'Fix the loop bound here',
      why_it_matters: 'The current loop reads past the end and returns NaN.',
      suggestion: '```suggestion\nfor (let i = 0; i < arr.length; i++) { sum += arr[i]; }\n```',
    });

    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.acceptedComments[0]!.suggestion).toBe(
      'for (let i = 0; i < arr.length; i++) { sum += arr[i]; }',
    );
  });
});

describe('normalizeSuggestion', () => {
  it('passes plain replacement code through', () => {
    expect(normalizeSuggestion('const x = 1;\n')).toBe('const x = 1;');
  });

  it('strips generic code fences too', () => {
    expect(normalizeSuggestion('```ts\nconst x = 2;\n```')).toBe('const x = 2;');
  });
});
