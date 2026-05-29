import { describe, expect, it } from 'vitest';
import type { FileReader } from '../github/file-reader.js';
import { makeReadFileAtRefTool } from './read-file-at-ref.js';
import { buildFakeDeps, callTool, getResultJson } from './test-helpers.js';

const HEAD_SHA = 'h'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

/** Capturing fake: records the `ref` (sha) each read was issued against. */
function capturingReader(): { reader: Partial<FileReader>; refs: string[] } {
  const refs: string[] = [];
  const reader: Partial<FileReader> = {
    read: async (ref) => {
      refs.push(ref.ref);
      return 'file contents\nsecond line\n';
    },
    readRange: async () => null,
  };
  return { reader, refs };
}

describe('read_file_at_ref tool', () => {
  it('defaults `ref` to head when omitted — reads HEAD, not BASE (regression)', async () => {
    // The schema declares `ref: z.enum(['head','base']).default('head')`. Before
    // the tool() helper parsed input, an omitted `ref` arrived as undefined and
    // the handler read BASE (`args.ref === 'head'` was false). A code reviewer
    // must read post-PR content by default, so this is a correctness bug.
    const { reader, refs } = capturingReader();
    const deps = buildFakeDeps({ fileReader: reader });
    const tool = makeReadFileAtRefTool(deps);

    const r = getResultJson(await callTool(tool, { path: 'src/foo.ts' })) as {
      ok: boolean;
      ref: string;
    };

    expect(r.ok).toBe(true);
    expect(r.ref).toBe('head');
    expect(refs).toEqual([HEAD_SHA]);
  });

  it('reads BASE when `ref` is explicitly "base"', async () => {
    const { reader, refs } = capturingReader();
    const deps = buildFakeDeps({ fileReader: reader });
    const tool = makeReadFileAtRefTool(deps);

    const r = getResultJson(await callTool(tool, { path: 'src/foo.ts', ref: 'base' })) as {
      ref: string;
    };

    expect(r.ref).toBe('base');
    expect(refs).toEqual([BASE_SHA]);
  });

  it('rejects an out-of-enum `ref` at the schema boundary', async () => {
    const { reader } = capturingReader();
    const deps = buildFakeDeps({ fileReader: reader });
    const tool = makeReadFileAtRefTool(deps);

    await expect(
      callTool(tool, { path: 'src/foo.ts', ref: 'main' } as unknown as Parameters<
        typeof callTool
      >[1]),
    ).rejects.toThrow(/Invalid arguments for read_file_at_ref/);
  });
});
