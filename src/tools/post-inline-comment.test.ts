import { describe, expect, it } from 'vitest';
import { makePostInlineCommentTool } from './post-inline-comment.js';
import { buildFakeDeps, getResultJson, makeFile } from './test-helpers.js';

describe('post_inline_comment tool', () => {
  it('accepts a valid critical comment with suggestion', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await tool.handler(
      {
        severity: 'critical',
        file_path: 'src/foo.ts',
        line: 10,
        side: 'RIGHT',
        category: 'bug',
        title: 'Off by one in loop',
        why_it_matters: 'Causes out-of-bounds read on the last iteration.',
        suggestion: 'for (let i = 0; i < arr.length; i++)',
        confidence: 'high',
      },
      undefined,
    );
    const json = getResultJson(result) as { accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(deps.aggregator.acceptedComments).toHaveLength(1);
    expect(deps.aggregator.acceptedComments[0]!.severity).toBe('critical');
  });

  it('rejects critical without suggestion', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await tool.handler(
      {
        severity: 'critical',
        file_path: 'src/foo.ts',
        line: 10,
        side: 'RIGHT',
        category: 'bug',
        title: 'Bug here',
        why_it_matters: 'It will crash on certain inputs and lose user data.',
        confidence: 'high',
      },
      undefined,
    );
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('requires a suggestion');
  });

  it('rejects comment on line outside reviewable range', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await tool.handler(
      {
        severity: 'minor',
        file_path: 'src/foo.ts',
        line: 50,
        side: 'RIGHT',
        category: 'readability',
        title: 'Some minor thing',
        why_it_matters: 'Could be clearer in how it names the variable.',
        confidence: 'high',
      },
      undefined,
    );
    const json = getResultJson(result) as { accepted: boolean; reason: string; hint: string };
    expect(json.accepted).toBe(false);
    expect(json.hint).toContain('10-15');
  });

  it('rejects unknown file_path with nearest-match hint', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await tool.handler(
      {
        severity: 'minor',
        file_path: 'src/bar.ts',
        line: 10,
        side: 'RIGHT',
        category: 'bug',
        title: 'A title',
        why_it_matters: 'Reason for this finding goes here.',
        confidence: 'high',
      },
      undefined,
    );
    const json = getResultJson(result) as { accepted: boolean; hint: string };
    expect(json.accepted).toBe(false);
    expect(json.hint).toContain('src/foo.ts');
  });

  it('rejects start_line >= line', async () => {
    const deps = buildFakeDeps({ files: [makeFile()] });
    const tool = makePostInlineCommentTool(deps);
    const result = await tool.handler(
      {
        severity: 'minor',
        file_path: 'src/foo.ts',
        line: 10,
        start_line: 10,
        side: 'RIGHT',
        category: 'readability',
        title: 'A title',
        why_it_matters: 'Reason for this finding goes here.',
        confidence: 'high',
      },
      undefined,
    );
    const json = getResultJson(result) as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toContain('start_line');
  });
});
