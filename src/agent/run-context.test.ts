import { describe, expect, it } from 'vitest';
import { createRunContext, hasReadRange, recordHeadRead } from './run-context.js';

describe('RunContext', () => {
  it('starts with no recorded ranges', () => {
    const ctx = createRunContext();
    expect(hasReadRange(ctx, 'src/foo.ts', 10)).toBe(false);
  });

  it('records a range and matches lines inside it', () => {
    const ctx = createRunContext();
    recordHeadRead(ctx, 'src/foo.ts', 5, 20);
    expect(hasReadRange(ctx, 'src/foo.ts', 5)).toBe(true);
    expect(hasReadRange(ctx, 'src/foo.ts', 12)).toBe(true);
    expect(hasReadRange(ctx, 'src/foo.ts', 20)).toBe(true);
    expect(hasReadRange(ctx, 'src/foo.ts', 4)).toBe(false);
    expect(hasReadRange(ctx, 'src/foo.ts', 21)).toBe(false);
  });

  it('treats different files independently', () => {
    const ctx = createRunContext();
    recordHeadRead(ctx, 'src/foo.ts', 5, 20);
    expect(hasReadRange(ctx, 'src/bar.ts', 12)).toBe(false);
    expect(hasReadRange(ctx, 'src/foo.ts', 12)).toBe(true);
  });

  it('accumulates multiple disjoint ranges per file', () => {
    const ctx = createRunContext();
    recordHeadRead(ctx, 'src/foo.ts', 1, 10);
    recordHeadRead(ctx, 'src/foo.ts', 50, 60);
    expect(hasReadRange(ctx, 'src/foo.ts', 5)).toBe(true);
    expect(hasReadRange(ctx, 'src/foo.ts', 25)).toBe(false);
    expect(hasReadRange(ctx, 'src/foo.ts', 55)).toBe(true);
  });

  it('ignores empty / inverted ranges (defensive)', () => {
    const ctx = createRunContext();
    recordHeadRead(ctx, 'src/foo.ts', 10, 5);
    expect(hasReadRange(ctx, 'src/foo.ts', 7)).toBe(false);
  });
});
