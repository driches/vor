/**
 * Reads file content at a specific git ref via the Contents API.
 * Uses a simple LRU cache to avoid re-fetching during a single review.
 */

import type { Octokit } from '@octokit/rest';
import { GitHubApiError } from '../util/errors.js';

export interface FileReadRef {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export class FileReader {
  private cache = new Map<string, string>();

  constructor(
    private readonly octokit: Octokit,
    private readonly maxEntries = 100,
  ) {}

  /**
   * Read a file's full UTF-8 content at the given ref.
   * Returns `null` if the file doesn't exist at that ref (404) or is too large.
   */
  async read(ref: FileReadRef): Promise<string | null> {
    const key = `${ref.owner}/${ref.repo}@${ref.ref}::${ref.path}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // LRU touch
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    try {
      const r = await this.octokit.rest.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: ref.path,
        ref: ref.ref,
      });
      if (Array.isArray(r.data) || r.data.type !== 'file') {
        return null;
      }
      const content = Buffer.from(r.data.content, r.data.encoding as BufferEncoding).toString(
        'utf-8',
      );
      this.set(key, content);
      return content;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw new GitHubApiError(`Failed to read ${ref.path}@${ref.ref}`, status, { cause: err });
    }
  }

  /** Read a specific line range. Returns null if file doesn't exist. */
  async readRange(
    ref: FileReadRef,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; total_lines: number; returned_range: [number, number] } | null> {
    const full = await this.read(ref);
    if (full == null) return null;

    const lines = full.split('\n');
    const total = lines.length;
    const start = Math.max(1, startLine);
    const end = Math.min(total, endLine);
    const slice = lines.slice(start - 1, end).join('\n');
    return { content: slice, total_lines: total, returned_range: [start, end] };
  }

  private set(key: string, value: string): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}
