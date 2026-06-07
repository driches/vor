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
  // Binary reads use a separate cache so a UTF-8 read and a raw read of the
  // same path don't alias (one stores a string, the other a Buffer).
  private binaryCache = new Map<string, Buffer>();

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

  /**
   * Read a file's raw bytes at the given ref, without UTF-8 decoding. Returns
   * `null` if the file doesn't exist at that ref (404) or the Contents API
   * returns a directory rather than a file.
   *
   * Needed for images: {@link read} decodes everything as UTF-8, which corrupts
   * binary blobs. The OCR scanner and the `describe_image_at_ref` tool call
   * this to get the original PNG/JPG bytes.
   */
  async readBinary(ref: FileReadRef): Promise<Buffer | null> {
    const key = `${ref.owner}/${ref.repo}@${ref.ref}::${ref.path}`;
    const cached = this.binaryCache.get(key);
    if (cached !== undefined) {
      // LRU touch
      this.binaryCache.delete(key);
      this.binaryCache.set(key, cached);
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
      // The Contents API only inlines base64 content up to 1 MB; for larger
      // blobs it returns `encoding: "none"` with an empty `content`.
      // `Buffer.from('', 'none')` would throw "Unknown encoding: none" and the
      // caller would treat a perfectly readable multi-MB screenshot as a read
      // error — exactly the size range OCR cares about (the default cap is
      // 10 MB). Fall back to the Git Blobs API, which base64-encodes blobs up
      // to 100 MB, keyed by the blob SHA the Contents API still returns.
      let buf: Buffer;
      if (r.data.encoding === 'base64' && r.data.content) {
        buf = Buffer.from(r.data.content, 'base64');
      } else {
        const blob = await this.octokit.rest.git.getBlob({
          owner: ref.owner,
          repo: ref.repo,
          file_sha: r.data.sha,
        });
        buf = Buffer.from(blob.data.content, blob.data.encoding as BufferEncoding);
      }
      this.setBinary(key, buf);
      return buf;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw new GitHubApiError(`Failed to read ${ref.path}@${ref.ref}`, status, { cause: err });
    }
  }

  private set(key: string, value: string): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  private setBinary(key: string, value: Buffer): void {
    if (this.binaryCache.size >= this.maxEntries) {
      const firstKey = this.binaryCache.keys().next().value;
      if (firstKey !== undefined) this.binaryCache.delete(firstKey);
    }
    this.binaryCache.set(key, value);
  }
}
