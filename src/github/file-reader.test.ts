import { describe, expect, it, vi } from 'vitest';
import { FileReader } from './file-reader.js';

function mockOctokitGetContent(
  byPath: Record<string, string | null>,
): {
  rest: { repos: { getContent: ReturnType<typeof vi.fn> } };
} {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
          const content = byPath[path];
          if (content === null || content === undefined) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return {
            data: {
              type: 'file',
              content: Buffer.from(content, 'utf-8').toString('base64'),
              encoding: 'base64',
            },
          };
        }),
      },
    },
  };
}

describe('FileReader', () => {
  it('reads a file and returns UTF-8 string', async () => {
    const oct = mockOctokitGetContent({ 'src/foo.ts': 'hello world' });
    const reader = new FileReader(oct as never);
    const result = await reader.read({ owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'abc' });
    expect(result).toBe('hello world');
  });

  it('returns null on 404', async () => {
    const oct = mockOctokitGetContent({ 'src/missing.ts': null });
    const reader = new FileReader(oct as never);
    expect(
      await reader.read({ owner: 'o', repo: 'r', path: 'src/missing.ts', ref: 'abc' }),
    ).toBeNull();
  });

  it('caches reads — second call does not hit octokit', async () => {
    const oct = mockOctokitGetContent({ 'src/foo.ts': 'hello' });
    const reader = new FileReader(oct as never);
    await reader.read({ owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'abc' });
    await reader.read({ owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'abc' });
    expect(oct.rest.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it('different ref invalidates cache', async () => {
    const oct = mockOctokitGetContent({ 'src/foo.ts': 'hello' });
    const reader = new FileReader(oct as never);
    await reader.read({ owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'a' });
    await reader.read({ owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'b' });
    expect(oct.rest.repos.getContent).toHaveBeenCalledTimes(2);
  });

  it('readRange returns the requested slice', async () => {
    const oct = mockOctokitGetContent({ 'src/foo.ts': 'a\nb\nc\nd\ne' });
    const reader = new FileReader(oct as never);
    const r = await reader.readRange(
      { owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'abc' },
      2,
      4,
    );
    expect(r).not.toBeNull();
    expect(r!.content).toBe('b\nc\nd');
    expect(r!.total_lines).toBe(5);
    expect(r!.returned_range).toEqual([2, 4]);
  });

  it('readRange clamps to file bounds', async () => {
    const oct = mockOctokitGetContent({ 'src/foo.ts': 'a\nb\nc' });
    const reader = new FileReader(oct as never);
    const r = await reader.readRange(
      { owner: 'o', repo: 'r', path: 'src/foo.ts', ref: 'abc' },
      -5,
      100,
    );
    expect(r!.returned_range).toEqual([1, 3]);
  });

  it('LRU evicts oldest when over capacity', async () => {
    const oct = mockOctokitGetContent({ a: '1', b: '2', c: '3' });
    const reader = new FileReader(oct as never, 2);
    await reader.read({ owner: 'o', repo: 'r', path: 'a', ref: 'x' });
    await reader.read({ owner: 'o', repo: 'r', path: 'b', ref: 'x' });
    await reader.read({ owner: 'o', repo: 'r', path: 'c', ref: 'x' }); // evicts 'a'
    expect(oct.rest.repos.getContent).toHaveBeenCalledTimes(3);
    await reader.read({ owner: 'o', repo: 'r', path: 'a', ref: 'x' });
    expect(oct.rest.repos.getContent).toHaveBeenCalledTimes(4); // a re-fetched
  });
});
