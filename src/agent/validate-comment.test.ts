import { describe, expect, it } from 'vitest';
import type { ChangedFile, PostedComment } from '../types.js';
import { createRunContext, recordHeadRead } from './run-context.js';
import {
  nearestPath,
  validateInlineComment,
  type PostInlineCommentInput,
  type ValidationContext,
} from './validate-comment.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 10,
    deletions: 2,
    reviewable_lines: [
      [10, 15],
      [25, 30],
    ],
    added_lines: new Set([10, 11, 12, 13, 14, 15, 25, 26, 27, 28, 29, 30]),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 100,
    head_line_text: new Map([
      [10, 'const x = 1;'],
      [11, 'const y = 2;'],
      [25, 'return foo();'],
    ]),
    ...over,
  };
}

function makeCtx(over: Partial<ValidationContext> = {}): ValidationContext {
  const file = over.changedFiles?.get('src/foo.ts') ?? makeFile();
  return {
    changedFiles: new Map([[file.path, file]]),
    postedComments: [],
    severityFloor: 'nit',
    maxBodyChars: 600,
    ...over,
  };
}

function makeInput(over: Partial<PostInlineCommentInput> = {}): PostInlineCommentInput {
  return {
    severity: 'important',
    file_path: 'src/foo.ts',
    line: 11,
    side: 'RIGHT',
    category: 'bug',
    title: 'Missing await',
    why_it_matters: 'Promise rejects silently and request fails.',
    confidence: 'high',
    ...over,
  };
}

describe('validateInlineComment', () => {
  it('accepts a valid comment', () => {
    const r = validateInlineComment(makeInput(), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('rejects when file_path is not in PR (1)', () => {
    const r = validateInlineComment(makeInput({ file_path: 'src/missing.ts' }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('not in this PR');
    expect(r.hint).toContain('src/foo.ts');
  });

  it('rejects when file is binary (2)', () => {
    const ctx = makeCtx({ changedFiles: new Map([['src/foo.ts', makeFile({ is_binary: true })]]) });
    const r = validateInlineComment(makeInput(), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('binary');
    expect(r.hint).toContain('skip_file');
  });

  it('rejects when file is generated (2)', () => {
    const ctx = makeCtx({ changedFiles: new Map([['src/foo.ts', makeFile({ is_generated: true })]]) });
    const r = validateInlineComment(makeInput(), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('generated');
    expect(r.hint).toContain("reason: 'generated'");
  });

  it('rejects line outside reviewable range (3)', () => {
    const r = validateInlineComment(makeInput({ line: 50 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('line 50');
    expect(r.hint).toContain('10-15');
    expect(r.hint).toContain('25-30');
  });

  it('rejects start_line >= line (4)', () => {
    const r = validateInlineComment(makeInput({ line: 11, start_line: 11 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('start_line');
  });

  it('accepts valid multi-line comment', () => {
    const r = validateInlineComment(makeInput({ line: 13, start_line: 11 }), makeCtx());
    expect(r.ok).toBe(true);
  });

  it('rejects start_line outside reviewable range (5)', () => {
    const r = validateInlineComment(makeInput({ line: 13, start_line: 5 }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('start_line 5');
  });

  it('rejects suggestion identical to current line text (6)', () => {
    const r = validateInlineComment(
      makeInput({ line: 10, suggestion: 'const x = 1;' }),
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('identical');
  });

  it('accepts suggestion that differs (whitespace/case-insensitive compare)', () => {
    const r = validateInlineComment(
      makeInput({ line: 10, suggestion: 'const x = 2;' }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects severity below floor (7)', () => {
    const r = validateInlineComment(
      makeInput({ severity: 'nit' }),
      makeCtx({ severityFloor: 'minor' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain("severity 'nit'");
    expect(r.reason).toContain("floor 'minor'");
  });

  it('rejects body that exceeds maxBodyChars (8)', () => {
    const long = 'x'.repeat(700);
    const r = validateInlineComment(makeInput({ why_it_matters: long }), makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('body too long');
  });

  it('rejects duplicate by (path, line, normalized title) (9)', () => {
    const existing: PostedComment = {
      severity: 'important',
      file_path: 'src/foo.ts',
      line: 11,
      side: 'RIGHT',
      category: 'bug',
      title: '  Missing AWAIT  ',
      why_it_matters: 'old reason',
      confidence: 'high',
    };
    const r = validateInlineComment(makeInput(), makeCtx({ postedComments: [existing] }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('duplicate');
  });

  it('accepts second comment on same line with different title', () => {
    const existing: PostedComment = {
      severity: 'minor',
      file_path: 'src/foo.ts',
      line: 11,
      side: 'RIGHT',
      category: 'naming',
      title: 'Variable name unclear',
      why_it_matters: 'old reason',
      confidence: 'high',
    };
    const r = validateInlineComment(makeInput(), makeCtx({ postedComments: [existing] }));
    expect(r.ok).toBe(true);
  });
});

describe('nearestPath', () => {
  it('returns null for empty candidates', () => {
    expect(nearestPath('foo.ts', [])).toBeNull();
  });

  it('returns the closest match by Levenshtein distance', () => {
    expect(nearestPath('src/foo.ts', ['src/bar.ts', 'src/foo.tsx', 'README.md'])).toBe(
      'src/foo.tsx',
    );
  });

  it('returns exact match if present', () => {
    expect(nearestPath('foo.ts', ['foo.ts', 'bar.ts'])).toBe('foo.ts');
  });
});

describe('validateInlineComment — read-before-post (worker-delegation discipline)', () => {
  it('rejects a critical comment when target line has not been read in this run', () => {
    const ctx = makeCtx({ runContext: createRunContext() });
    const r = validateInlineComment(
      makeInput({ severity: 'critical', suggestion: 'fixed code' }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('have not called read_file_at_ref');
    expect(r.hint).toContain('read_file_at_ref');
    expect(r.hint).toContain("'src/foo.ts'");
  });

  it('rejects an important comment when target line has not been read', () => {
    const ctx = makeCtx({ runContext: createRunContext() });
    const r = validateInlineComment(
      makeInput({ severity: 'important', suggestion: 'fixed code' }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('have not called read_file_at_ref');
  });

  it('accepts a critical comment when target line falls inside a recorded read range', () => {
    const runContext = createRunContext();
    recordHeadRead(runContext, 'src/foo.ts', 5, 15);
    const ctx = makeCtx({ runContext });
    const r = validateInlineComment(
      makeInput({ severity: 'critical', line: 11, suggestion: 'fixed' }),
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('accepts minor and nit severities without a read (workers fine for low-stakes findings)', () => {
    const ctx = makeCtx({ runContext: createRunContext(), severityFloor: 'nit' });
    expect(
      validateInlineComment(makeInput({ severity: 'minor' }), ctx).ok,
    ).toBe(true);
    expect(
      validateInlineComment(makeInput({ severity: 'nit' }), ctx).ok,
    ).toBe(true);
  });

  it('skips the check entirely when runContext is omitted (back-compat for callers that have not opted in)', () => {
    // Legacy callers that don't pass runContext (because the worker
    // delegation flag is off) should see v0.2.x validator behavior — no
    // mandatory read-before-post.
    const ctx = makeCtx();
    delete (ctx as { runContext?: unknown }).runContext;
    const r = validateInlineComment(
      makeInput({ severity: 'critical', suggestion: 'fixed' }),
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});
