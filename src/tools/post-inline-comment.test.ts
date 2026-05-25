import { describe, expect, it } from 'vitest';
import { makePostInlineCommentTool } from './post-inline-comment.js';
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
      title: 'A title',
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
      title: 'A title',
      why_it_matters: 'Reason for this finding goes here.',
      confidence: 'high',
    });
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('start_line');
  });

  it('defaults `side` to RIGHT and `confidence` to high when omitted (PR #12 regression)', async () => {
    // The Zod schema declares `.default('RIGHT')` for side and
    // `.default('high')` for confidence, but the agent runner forwards raw
    // tool input to the handler without running it through Zod. The
    // handler must apply the schema defaults itself so the in-memory
    // PostedComment carries concrete values. If `side` lands as undefined,
    // the post-filter scanner-vs-AI dedup fails its `ai.side === c.side`
    // check (the scanner adapter hard-codes 'RIGHT'), and a scanner finding
    // co-located with an AI security comment ships as a duplicate. PR #12
    // and PR #16 smoke tests both reproduced exactly this failure.
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

  it('normalizes an out-of-enum `side`/`confidence` (e.g. lowercase) to the schema default', async () => {
    // Since Zod parsing is bypassed at the runner boundary, an LLM that
    // emits `side: 'left'` (lowercase) or `confidence: 'maybe'` would
    // otherwise be cast through `as Side`/`as Confidence` unchecked,
    // landing a malformed value in the aggregator. The handler defends
    // by allowlist: anything outside the enum collapses to the schema's
    // documented default.
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await callTool(tool, {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 10,
      side: 'left',
      category: 'readability',
      title: 'A reasonably descriptive title',
      why_it_matters: 'A short rationale that makes future readers care.',
      confidence: 'maybe',
    } as unknown as Parameters<typeof callTool>[1]);
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    const stored = deps.aggregator.acceptedComments[0]!;
    expect(stored.side).toBe('RIGHT');
    expect(stored.confidence).toBe('high');
  });

  it('preserves valid `side: LEFT` and `confidence: medium` when explicitly provided', async () => {
    // Pins the pass-through branch of the normalization allowlist: a valid
    // enum value must survive unchanged. Without this assertion, a typo
    // like `rawSide === 'left'` instead of `rawSide === 'LEFT'` in the
    // handler would silently collapse every LEFT-side comment to RIGHT
    // and the suite would still be green.
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
});
