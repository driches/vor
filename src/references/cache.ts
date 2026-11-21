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
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

function resolveCanonicalCachePath(absPath: string): string | null {
  const resolved = resolve(absPath);
  const missingSegs: string[] = [];
  let cursor = resolved;
  while (true) {
    let exists = false;
    try {
      lstatSync(cursor);
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return null;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        return null;
      }
      missingSegs.push(basename(cursor));
      cursor = parent;
    }
    if (exists) {
      // `lstatSync` succeeded, so any `realpathSync` failure here (including
      // ENOENT on a dangling symlink) must fail closed rather than walking up.
      try {
        const real = realpathSync(cursor);
        return missingSegs.length === 0 ? real : join(real, ...missingSegs.reverse());
      } catch {
        return null;
      }
    }
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isAllowedAbsoluteCacheDir(absPath: string, workspaceDir?: string): boolean {
  const canonical = resolveCanonicalCachePath(absPath);
  if (!canonical) return false;
  const roots = [workspaceDir ?? process.cwd(), tmpdir()];
  const runnerTemp = process.env.RUNNER_TEMP?.trim();
  if (runnerTemp) roots.push(runnerTemp);
  const vorCache = process.env.VOR_CACHE_DIR?.trim();
  if (vorCache) roots.push(vorCache);
  const vorHome = process.env.VOR_HOME?.trim();
  roots.push(vorHome ? vorHome : join(homedir(), '.vor'));

  return roots.some((root) => {
    const canonicalRoot = resolveCanonicalCachePath(root);
    return canonicalRoot !== null && isInsideRoot(canonical, canonicalRoot);
  });
}

function isSafeExistingCacheDir(cacheDir: string): boolean {
  try {
    const st = lstatSync(cacheDir);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false; // missing or inaccessible cache directory
  }
}

function ensureSafeWritableCacheDir(cacheDir: string): void {
  try {
    const st = lstatSync(cacheDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Cache directory '${cacheDir}' must be a real non-symlink directory.`);
    }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  mkdirSync(cacheDir, { recursive: true });
  const created = lstatSync(cacheDir);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Cache directory '${cacheDir}' must be a real non-symlink directory.`);
  }
}

function assertRegularOrMissingFile(filePath: string): void {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(
        `Refusing to write cache entry through symlinked or non-regular path '${filePath}'.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

function writeFileNoFollow(filePath: string, data: string): void {
  assertRegularOrMissingFile(filePath);
  // Combine upfront lstat rejection with O_NOFOLLOW at open(2) so cache writes
  // cannot follow symlinks under concurrent replacement. O_NOFOLLOW is undefined
  // on Windows; the upfront lstatSync check serves as the guard there.
  const noFollowFlag = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag,
    0o600,
  );
  try {
    writeFileSync(fd, data, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

function readFileNoFollow(filePath: string): string {
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(
      `Refusing to read cache entry from symlinked or non-regular path '${filePath}'.`,
    );
  }
  // O_NOFOLLOW is undefined on Windows; the lstatSync check above is the primary guard there.
  const noFollowFlag = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(filePath, constants.O_RDONLY | noFollowFlag);
  try {
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the cache directory for reference docs.
 * Relative configured dirs are canonically confined inside `workspaceDir`;
 * absolute paths are confined to trusted workspace, temp (`os.tmpdir()` / `$RUNNER_TEMP`),
 * or VOR cache/home directories.
 */
export function resolveReferenceCacheDir(configuredDir?: string, workspaceDir?: string): string {
  if (configuredDir && configuredDir.trim().length > 0) {
    const trimmed = configuredDir.trim();
    if (isAbsolute(trimmed)) {
      const canonical = resolveCanonicalCachePath(trimmed);
      if (canonical && isAllowedAbsoluteCacheDir(canonical, workspaceDir)) {
        return canonical;
      }
      void logger.warn(
        `Configured references.cache.dir '${configuredDir}' is outside allowed workspace/temp/cache roots; falling back to default cache dir.`,
      );
      return defaultCacheDir();
    }
    const base = workspaceDir ?? process.cwd();
    if (isSafeRelativePath(base, trimmed)) {
      const canonicalBase = resolveCanonicalCachePath(base);
      const canonicalTarget = resolveCanonicalCachePath(resolve(base, trimmed));
      if (canonicalBase && canonicalTarget && isInsideRoot(canonicalTarget, canonicalBase)) {
        return canonicalTarget;
      }
      void logger.warn(
        `Configured references.cache.dir '${configuredDir}' resolves outside workspace root via symlink; falling back to default cache dir.`,
      );
      return defaultCacheDir();
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

  get(key: string, nowMs: number = Date.now(), ttlSecondsOverride?: number): CacheLookupResult {
    if (!isSafeExistingCacheDir(this.cacheDir)) {
      return { status: 'miss' };
    }
    const { metaPath, contentPath } = this.entryPaths(key);

    let metaRaw: string;
    let content: string;
    try {
      metaRaw = readFileNoFollow(metaPath);
      content = readFileNoFollow(contentPath);
    } catch {
      return { status: 'miss' }; // missing, unreadable, or symlinked entry degrades to miss
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
    const effectiveTtlSeconds = ttlSecondsOverride ?? meta.ttl_seconds;
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < effectiveTtlSeconds * 1000;
    return fresh ? { status: 'hit', meta, content } : { status: 'stale', meta, content };
  }

  set(key: string, meta: ReferenceCacheMeta, content: string): boolean {
    try {
      ensureSafeWritableCacheDir(this.cacheDir);
      const { metaPath, contentPath } = this.entryPaths(key);
      assertRegularOrMissingFile(contentPath);
      assertRegularOrMissingFile(metaPath);
      // Write content before `.meta.json`: `list()` indexes `.meta.json` sidecars,
      // so `.meta.json` acts as the commit marker and prevents partial entries.
      writeFileNoFollow(contentPath, content);
      writeFileNoFollow(metaPath, JSON.stringify(meta, null, 2) + '\n');
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
    if (!isSafeExistingCacheDir(this.cacheDir)) return null;
    const { metaPath } = this.entryPaths(key);
    try {
      const parsed = cacheMetaSchema.safeParse(JSON.parse(readFileNoFollow(metaPath)));
      if (!parsed.success) return null;
      const merged: ReferenceCacheMeta = {
        ...parsed.data,
        ...updates,
      };
      writeFileNoFollow(metaPath, JSON.stringify(merged, null, 2) + '\n');
      return merged;
    } catch {
      return null; // touch failure (including symlink rejection) is non-fatal; next run will refresh
    }
  }

  list(): ReferenceCacheMeta[] {
    if (!isSafeExistingCacheDir(this.cacheDir)) return [];
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
          JSON.parse(readFileNoFollow(join(this.cacheDir, file))),
        );
        if (parsed.success) entries.push(parsed.data as ReferenceCacheMeta);
      } catch {
        // Skip malformed or symlinked sidecars during listing.
      }
    }
    return entries.sort((a, b) => a.source_id.localeCompare(b.source_id));
  }

  clear(idOrKey?: string): number {
    if (!isSafeExistingCacheDir(this.cacheDir)) return 0;
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
          const parsed = cacheMetaSchema.safeParse(JSON.parse(readFileNoFollow(metaPath)));
          if (
            parsed.success &&
            (parsed.data.source_id === idOrKey || parsed.data.key === idOrKey)
          ) {
            shouldDelete = true;
          }
        } catch {
          // Corrupt or symlinked file matched by idOrKey check: ignore.
        }
      }

      if (!shouldDelete) continue;
      try {
        unlinkSync(metaPath);
        try {
          unlinkSync(contentPath);
        } catch {
          // Sibling .content may be absent for orphaned sidecars.
        }
        removed += 1;
      } catch {
        // Best-effort cleanup.
      }
    }
    if (idOrKey === undefined) {
      const fileSet = new Set(files);
      for (const file of files) {
        if (!file.endsWith('.content')) continue;
        const hash = file.slice(0, -'.content'.length);
        if (fileSet.has(`${hash}.meta.json`)) continue;
        try {
          unlinkSync(join(this.cacheDir, file));
        } catch {
          // Best-effort orphan cleanup.
        }
      }
    }
    return removed;
  }
}
