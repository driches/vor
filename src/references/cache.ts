/**
 * Persistent content-addressed disk cache for reference documentation & standards.
 *
 * Uses SHA-256 cache keys with sidecar metadata (`.meta.json` + `.content`) so:
 *   - Remote HTTP/HTTPS docs avoid redundant fetches via TTL and conditional
 *     ETag / `If-Modified-Since` (`304 Not Modified`) revalidation.
 *   - Offline / flaky network runs can degrade to cached content (`stale_on_error`).
 *   - CI workflows can persist `~/.vor/cache` or `$VOR_CACHE_DIR` with `actions/cache`.
 *
 * Deliberately reads `$VOR_HOME` / `$VOR_CACHE_DIR` directly rather than
 * importing `src/local/store.ts` so `dist/index.js` stays isolated from `src/local/`.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { isSafeRelativePath } from '../architecture/loader.js';
import { logger } from '../util/logger.js';

export interface ReferenceCacheMeta {
  version: 1;
  key: string;
  source_id: string;
  title: string;
  kind: 'repo' | 'url' | 'github';
  content_sha256: string;
  etag?: string;
  last_modified?: string;
  source_fingerprint?: string;
  fetched_at: string;
  ttl_seconds: number;
  byte_length: number;
  headings: string[];
}

const cacheMetaSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  source_id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['repo', 'url', 'github']),
  content_sha256: z.string().min(1),
  etag: z.string().optional(),
  last_modified: z.string().optional(),
  source_fingerprint: z.string().optional(),
  fetched_at: z.string().min(1),
  ttl_seconds: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  headings: z.array(z.string()),
});

export type CacheLookupResult =
  | { status: 'hit'; meta: ReferenceCacheMeta; content: string }
  | { status: 'stale'; meta: ReferenceCacheMeta; content: string }
  | { status: 'miss' };

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function defaultCacheDir(): string {
  const cacheOverride = process.env.VOR_CACHE_DIR?.trim();
  if (cacheOverride) {
    return join(resolve(cacheOverride), 'references');
  }
  const vorHomeOverride = process.env.VOR_HOME?.trim();
  const vorHome = vorHomeOverride ? resolve(vorHomeOverride) : join(homedir(), '.vor');
  return join(vorHome, 'cache', 'references');
}

/**
 * Resolve the cache directory for reference docs.
 * Relative configured dirs are confined inside `workspaceDir`; absolute paths
 * (such as `$RUNNER_TEMP/vor-cache` in GitHub Actions) are accepted directly.
 */
export function resolveReferenceCacheDir(configuredDir?: string, workspaceDir?: string): string {
  if (configuredDir && configuredDir.trim().length > 0) {
    const trimmed = configuredDir.trim();
    if (isAbsolute(trimmed)) return trimmed;
    const base = workspaceDir ?? process.cwd();
    if (isSafeRelativePath(base, trimmed)) {
      return resolve(base, trimmed);
    }
    void logger.warn(
      `Configured references.cache.dir '${configuredDir}' escapes workspace root; falling back to default cache dir.`,
    );
  }
  return defaultCacheDir();
}

export class DiskReferenceCache {
  constructor(public readonly cacheDir: string) {}

  private entryPaths(key: string): { hash: string; metaPath: string; contentPath: string } {
    const hash = sha256Hex(key);
    return {
      hash,
      metaPath: join(this.cacheDir, `${hash}.meta.json`),
      contentPath: join(this.cacheDir, `${hash}.content`),
    };
  }

  get(key: string, nowMs: number = Date.now()): CacheLookupResult {
    const { metaPath, contentPath } = this.entryPaths(key);
    if (!existsSync(metaPath) || !existsSync(contentPath)) {
      return { status: 'miss' };
    }

    let metaRaw: string;
    let content: string;
    try {
      metaRaw = readFileSync(metaPath, 'utf-8');
      content = readFileSync(contentPath, 'utf-8');
    } catch {
      return { status: 'miss' }; // unreadable cache entry degrades to cache miss
    }

    let parsedMeta: unknown;
    try {
      parsedMeta = JSON.parse(metaRaw);
    } catch {
      void logger.warn(`Corrupt reference cache metadata for '${key}'; treating as miss.`);
      return { status: 'miss' };
    }

    const valid = cacheMetaSchema.safeParse(parsedMeta);
    if (!valid.success) {
      void logger.warn(`Invalid reference cache metadata schema for '${key}'; treating as miss.`);
      return { status: 'miss' };
    }

    const meta = valid.data as ReferenceCacheMeta;
    if (sha256Hex(content) !== meta.content_sha256) {
      void logger.warn(`Reference cache checksum mismatch for '${key}'; treating as miss.`);
      return { status: 'miss' };
    }

    const fetchedMs = Date.parse(meta.fetched_at);
    const ageMs = nowMs - fetchedMs;
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < meta.ttl_seconds * 1000;
    return fresh ? { status: 'hit', meta, content } : { status: 'stale', meta, content };
  }

  set(key: string, meta: ReferenceCacheMeta, content: string): boolean {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const { metaPath, contentPath } = this.entryPaths(key);
      writeFileSync(contentPath, content, 'utf-8');
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
      return true;
    } catch (err) {
      void logger.warn(
        `Failed to persist reference cache entry '${key}' in '${this.cacheDir}': ${(err as Error).message}`,
      );
      return false;
    }
  }

  touch(
    key: string,
    updates: Partial<
      Pick<ReferenceCacheMeta, 'fetched_at' | 'etag' | 'last_modified' | 'ttl_seconds'>
    >,
  ): ReferenceCacheMeta | null {
    const { metaPath } = this.entryPaths(key);
    if (!existsSync(metaPath)) return null;
    try {
      const parsed = cacheMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, 'utf-8')));
      if (!parsed.success) return null;
      const merged: ReferenceCacheMeta = {
        ...parsed.data,
        ...updates,
      };
      writeFileSync(metaPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
      return merged;
    } catch {
      return null; // touch failure is non-fatal; next run will refresh
    }
  }

  list(): ReferenceCacheMeta[] {
    if (!existsSync(this.cacheDir)) return [];
    let files: string[];
    try {
      files = readdirSync(this.cacheDir);
    } catch {
      return []; // unreadable cache directory
    }
    const entries: ReferenceCacheMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      try {
        const parsed = cacheMetaSchema.safeParse(
          JSON.parse(readFileSync(join(this.cacheDir, file), 'utf-8')),
        );
        if (parsed.success) entries.push(parsed.data as ReferenceCacheMeta);
      } catch {
        // Skip malformed sidecars during listing.
      }
    }
    return entries.sort((a, b) => a.source_id.localeCompare(b.source_id));
  }

  clear(idOrKey?: string): number {
    if (!existsSync(this.cacheDir)) return 0;
    let files: string[];
    try {
      files = readdirSync(this.cacheDir);
    } catch {
      return 0; // unreadable cache directory
    }
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      const hash = file.slice(0, -'.meta.json'.length);
      const metaPath = join(this.cacheDir, file);
      const contentPath = join(this.cacheDir, `${hash}.content`);

      let shouldDelete = false;
      if (idOrKey === undefined || hash === idOrKey) {
        shouldDelete = true;
      } else {
        try {
          const parsed = cacheMetaSchema.safeParse(JSON.parse(readFileSync(metaPath, 'utf-8')));
          if (
            parsed.success &&
            (parsed.data.source_id === idOrKey || parsed.data.key === idOrKey)
          ) {
            shouldDelete = true;
          }
        } catch {
          // Corrupt file matched by idOrKey check: ignore.
        }
      }

      if (!shouldDelete) continue;
      try {
        unlinkSync(metaPath);
        if (existsSync(contentPath)) unlinkSync(contentPath);
        removed += 1;
      } catch {
        // Best-effort cleanup.
      }
    }
    return removed;
  }
}
