import { describe, expect, it, vi } from 'vitest';
import { FileReader } from './file-reader.js';

function mockOctokitGetContent(byPath: Record<string, string | null>): {
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

  describe('readBinary', () => {
    /** getContent mock that returns raw bytes (base64-encoded) for given paths. */
    function mockBinaryGetContent(byPath: Record<string, Buffer | null>) {
      return {
        rest: {
          repos: {
            getContent: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
              const buf = byPath[path];
              if (buf === null || buf === undefined) {
                throw Object.assign(new Error('Not Found'), { status: 404 });
              }
              return {
                data: { type: 'file', content: buf.toString('base64'), encoding: 'base64' },
              };
            }),
          },
        },
      };
    }

    it('returns the raw bytes without UTF-8 decoding', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const oct = mockBinaryGetContent({ 'a.png': png });
      const reader = new FileReader(oct as never);
      const out = await reader.readBinary({ owner: 'o', repo: 'r', path: 'a.png', ref: 'x' });
      expect(out).not.toBeNull();
      expect(Buffer.compare(out!, png)).toBe(0);
    });

    it('returns null on 404', async () => {
      const oct = mockBinaryGetContent({ 'gone.png': null });
      const reader = new FileReader(oct as never);
      expect(
        await reader.readBinary({ owner: 'o', repo: 'r', path: 'gone.png', ref: 'x' }),
      ).toBeNull();
    });

    it('caches binary reads independently of text reads', async () => {
      const png = Buffer.from([1, 2, 3]);
      const oct = mockBinaryGetContent({ 'a.png': png });
      const reader = new FileReader(oct as never);
      await reader.readBinary({ owner: 'o', repo: 'r', path: 'a.png', ref: 'x' });
      await reader.readBinary({ owner: 'o', repo: 'r', path: 'a.png', ref: 'x' });
      expect(oct.rest.repos.getContent).toHaveBeenCalledTimes(1); // second served from cache
    });

    it('falls back to the Git Blobs API when the Contents API omits inline content', async () => {
      // GitHub returns `encoding: "none"` with empty content for blobs over
      // 1 MB; readBinary must fetch the blob by SHA rather than choke on it.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x10]);
      const getBlob = vi.fn().mockResolvedValue({
        data: { content: png.toString('base64'), encoding: 'base64' },
      });
      const oct = {
        rest: {
          repos: {
            getContent: vi.fn().mockResolvedValue({
              data: { type: 'file', content: '', encoding: 'none', sha: 'blobsha123' },
            }),
          },
          git: { getBlob },
        },
      };
      const reader = new FileReader(oct as never);
      const out = await reader.readBinary({ owner: 'o', repo: 'r', path: 'big.png', ref: 'x' });
      expect(out).not.toBeNull();
      expect(Buffer.compare(out!, png)).toBe(0);
      expect(getBlob).toHaveBeenCalledWith({ owner: 'o', repo: 'r', file_sha: 'blobsha123' });
    });
  });
});
