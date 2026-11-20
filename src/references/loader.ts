/**
 * Unified loader for reference documentation & engineering standards.
 *
 * Supports:
 *   - Repo files and globs (`docs/adr/**`)
 *   - Remote HTTP/HTTPS URLs (HTML converted to markdown-text, with ETag/304 + TTL)
 *   - Cross-repo GitHub files/globs (`github:owner/repo/path[@ref]`)
 *
 * Allocates docs into `inline` (system-prompt prefix) vs `on_demand`
 * (`read_reference_doc` tool) within `max_inline_bytes`, and computes a
 * deterministic `corpus_digest` for LLM prompt-caching stability.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { matchesGlob, normalizePath } from '../architecture/glob.js';
import { isSafeRelativePath } from '../architecture/loader.js';
import type {
  ReferenceMode,
  ReferencesConfig,
  ReferenceSourceInput,
  ReferenceSourceObject,
} from '../config/types.js';
import type { FileReader } from '../github/file-reader.js';
import {
  DiskReferenceCache,
  resolveReferenceCacheDir,
  sha256Hex,
  type ReferenceCacheMeta,
} from './cache.js';
import {
  extractDocumentHeadings,
  isLikelyBinary,
  normalizeDocumentText,
  truncateUtf8Bytes,
} from './text.js';

export type ReferenceCacheStatus = 'hit' | 'revalidated' | 'miss' | 'stale-fallback' | 'uncached';

export interface LoadedReferenceDoc {
  id: string;
  title: string;
  source: string;
  kind: 'repo' | 'url' | 'github';
  placement: 'inline' | 'on_demand';
  content: string;
  byte_length: number;
  content_sha256: string;
  headings: string[];
  truncated: boolean;
  cache_status: ReferenceCacheStatus;
}

export interface LoadedReferenceCorpus {
  docs: LoadedReferenceDoc[];
  inline_docs: LoadedReferenceDoc[];
  on_demand_docs: LoadedReferenceDoc[];
  total_inline_bytes: number;
  total_bytes: number;
  corpus_digest: string;
  cache_dir: string;
  cache_stats: {
    hits: number;
    revalidated: number;
    misses: number;
    stale_fallbacks: number;
    uncached: number;
  };
  warnings: string[];
}

export interface LoadReferencesInput {
  config: ReferencesConfig;
  owner?: string;
  repo?: string;
  ref?: string;
  workspaceDir?: string;
  fileReader?: FileReader;
  octokit?: Octokit;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  nowMs?: number;
}

type NormalizedSource =
  | {
      kind: 'repo-file';
      path: string;
      id?: string;
      title?: string;
      mode: ReferenceMode;
      ttl_seconds?: number;
    }
  | {
      kind: 'repo-glob';
      glob: string;
      id?: string;
      title?: string;
      mode: ReferenceMode;
      ttl_seconds?: number;
    }
  | {
      kind: 'url';
      url: string;
      id?: string;
      title?: string;
      mode: ReferenceMode;
      ttl_seconds?: number;
    }
  | {
      kind: 'github';
      owner: string;
      repo: string;
      path: string;
      ref: string;
      rawSpec: string;
      id?: string;
      title?: string;
      mode: ReferenceMode;
      ttl_seconds?: number;
    };

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RAW_REMOTE_BYTES = 5 * 1024 * 1024;
const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'vendor',
  'coverage',
  '__generated__',
]);
const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
]);

function hasGlobMeta(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('{');
}

function parseGithubSpec(raw: string): {
  owner: string;
  repo: string;
  path: string;
  ref: string;
} | null {
  const cleaned = raw.startsWith('github:') ? raw.slice('github:'.length) : raw;
  const parts = cleaned.split('/');
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const owner = parts[0];
  const repo = parts[1];
  const rest = parts.slice(2).join('/');
  const lastSlash = rest.lastIndexOf('/');
  const lastAt = rest.lastIndexOf('@');
  if (lastAt > lastSlash && lastAt < rest.length - 1) {
    const path = rest.slice(0, lastAt);
    const ref = rest.slice(lastAt + 1);
    return path ? { owner, repo, path, ref } : null;
  }
  return rest ? { owner, repo, path: rest, ref: 'HEAD' } : null;
}

function normalizeSourceInput(
  entry: ReferenceSourceInput,
  warnings: string[],
): NormalizedSource | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
      return { kind: 'url', url: trimmed, mode: 'auto' };
    }
    if (trimmed.startsWith('github:')) {
      const gh = parseGithubSpec(trimmed);
      if (!gh) {
        warnings.push(
          `Invalid GitHub reference source '${trimmed}'. Expected github:owner/repo/path[@ref].`,
        );
        return null;
      }
      return { kind: 'github', ...gh, rawSpec: trimmed, mode: 'auto' };
    }
    if (hasGlobMeta(trimmed)) {
      return { kind: 'repo-glob', glob: trimmed, mode: 'auto' };
    }
    return { kind: 'repo-file', path: trimmed, mode: 'auto' };
  }

  const obj: ReferenceSourceObject = entry;
  const mode: ReferenceMode = obj.mode ?? 'auto';
  const common = {
    ...(obj.id !== undefined ? { id: obj.id } : {}),
    ...(obj.title !== undefined ? { title: obj.title } : {}),
    mode,
    ...(obj.ttl_seconds !== undefined ? { ttl_seconds: obj.ttl_seconds } : {}),
  };

  if (obj.url) return { kind: 'url', url: obj.url, ...common };
  if (obj.github) {
    const gh = parseGithubSpec(obj.github);
    if (!gh) {
      warnings.push(
        `Invalid GitHub reference source '${obj.github}'. Expected owner/repo/path[@ref].`,
      );
      return null;
    }
    return {
      kind: 'github',
      ...gh,
      rawSpec: `github:${gh.owner}/${gh.repo}/${gh.path}@${gh.ref}`,
      ...common,
    };
  }
  if (obj.glob) return { kind: 'repo-glob', glob: obj.glob, ...common };
  if (obj.path) return { kind: 'repo-file', path: obj.path, ...common };

  warnings.push('Reference source object has none of path, glob, url, or github; skipping.');
  return null;
}

function validateRemoteUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme '${url.protocol}'`);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    throw new Error(`Blocked metadata host '${host}'`);
  }
  return url;
}

function inferTitle(
  explicitTitle: string | undefined,
  content: string,
  fallbackSource: string,
): string {
  if (explicitTitle && explicitTitle.trim().length > 0) return explicitTitle.trim();
  const h1 = content.match(/^#\s+(.+?)\s*#*$/m);
  if (h1?.[1]) return h1[1].trim();
  try {
    if (/^https?:\/\//i.test(fallbackSource)) {
      const u = new URL(fallbackSource);
      const last = basename(u.pathname);
      return last && last !== '/' ? last : u.hostname;
    }
  } catch {
    // Fall back to path basename below when string isn't a URL.
  }
  return basename(fallbackSource) || fallbackSource;
}

function enumerateWorkspaceFiles(workspaceDir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .split('\0')
      .map((p) => normalizePath(p))
      .filter(Boolean);
  } catch {
    // Fallback for non-git directories.
    const files: string[] = [];
    const walk = (dir: string, relBase: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) files.push(normalizePath(rel));
      }
    };
    walk(workspaceDir, '');
    return files;
  }
}

async function listRepoGlobFiles(
  pattern: string,
  input: LoadReferencesInput,
  warnings: string[],
): Promise<string[]> {
  if (input.workspaceDir && existsSync(input.workspaceDir)) {
    const files = enumerateWorkspaceFiles(input.workspaceDir);
    const matched = files.filter((f) => matchesGlob(f, pattern)).sort();
    if (matched.length > 0) return matched;
  }

  if (input.octokit?.rest?.git?.getTree && input.owner && input.repo && input.ref) {
    try {
      const r = await input.octokit.rest.git.getTree({
        owner: input.owner,
        repo: input.repo,
        tree_sha: input.ref,
        recursive: '1',
      });
      const paths = (r.data.tree ?? [])
        .filter((item) => item.type === 'blob' && typeof item.path === 'string')
        .map((item) => normalizePath(item.path!))
        .filter((p) => matchesGlob(p, pattern))
        .sort();
      return paths;
    } catch (err) {
      warnings.push(
        `Failed to list repo glob '${pattern}' via Git Tree API: ${(err as Error).message}`,
      );
    }
  }

  return [];
}

interface RawLoadedDoc {
  id: string;
  title: string;
  source: string;
  kind: 'repo' | 'url' | 'github';
  mode: ReferenceMode;
  content: string;
  byte_length: number;
  content_sha256: string;
  headings: string[];
  truncated: boolean;
  cache_status: ReferenceCacheStatus;
}

function finalizeNormalizedDoc(
  rawText: string,
  opts: {
    id: string;
    explicitTitle?: string;
    source: string;
    kind: 'repo' | 'url' | 'github';
    mode: ReferenceMode;
    maxDocBytes: number;
    contentType?: string;
    cacheStatus: ReferenceCacheStatus;
  },
): RawLoadedDoc {
  const normalized = normalizeDocumentText(rawText, opts.contentType);
  const { content, truncated } = truncateUtf8Bytes(normalized, opts.maxDocBytes);
  return {
    id: opts.id,
    title: inferTitle(opts.explicitTitle, content, opts.source),
    source: opts.source,
    kind: opts.kind,
    mode: opts.mode,
    content,
    byte_length: Buffer.byteLength(content, 'utf-8'),
    content_sha256: sha256Hex(content),
    headings: extractDocumentHeadings(content),
    truncated,
    cache_status: opts.cacheStatus,
  };
}

async function loadRepoFile(
  repoPath: string,
  metaOpts: { id?: string; title?: string; mode: ReferenceMode; ttl_seconds?: number },
  input: LoadReferencesInput,
  cache: DiskReferenceCache | null,
  warnings: string[],
): Promise<RawLoadedDoc | null> {
  const baseDir = input.workspaceDir ?? process.cwd();
  if (!isSafeRelativePath(baseDir, repoPath)) {
    warnings.push(`Reference path '${repoPath}' escapes workspace root; skipping.`);
    return null;
  }

  const normPath = normalizePath(repoPath);
  const cacheKey = `repo:${input.owner ?? 'local'}/${input.repo ?? 'local'}:${normPath}`;
  const nowMs = input.nowMs ?? Date.now();
  const ttl = metaOpts.ttl_seconds ?? input.config.cache.ttl_seconds;

  let diskFingerprint: string | undefined;
  let diskContent: string | null = null;
  if (input.workspaceDir) {
    const abs = resolve(input.workspaceDir, normPath);
    if (existsSync(abs)) {
      try {
        const st = statSync(abs);
        if (st.isFile()) {
          diskFingerprint = `${st.mtimeMs}:${st.size}`;
          if (cache && !input.forceRefresh) {
            const cached = cache.get(cacheKey, nowMs);
            if (cached.status === 'hit' && cached.meta.source_fingerprint === diskFingerprint) {
              return {
                id: metaOpts.id ?? normPath,
                title: metaOpts.title ?? cached.meta.title,
                source: normPath,
                kind: 'repo',
                mode: metaOpts.mode,
                content: cached.content,
                byte_length: cached.meta.byte_length,
                content_sha256: cached.meta.content_sha256,
                headings: cached.meta.headings,
                truncated: false,
                cache_status: 'hit',
              };
            }
          }
          const buf = readFileSync(abs);
          if (isLikelyBinary(buf)) {
            warnings.push(`Reference file '${normPath}' appears to be binary; skipping.`);
            return null;
          }
          diskContent = buf.toString('utf-8');
        }
      } catch {
        // Fall through to FileReader when local file cannot be stat/read directly.
      }
    }
  }

  let rawText: string | null = null;
  if (input.fileReader && input.owner && input.repo && input.ref) {
    try {
      rawText = await input.fileReader.read({
        owner: input.owner,
        repo: input.repo,
        path: normPath,
        ref: input.ref,
      });
    } catch {
      rawText = null; // fallback to local workspace content when Contents API read fails
    }
  }
  if (rawText === null) rawText = diskContent;

  if (rawText === null) {
    warnings.push(`Reference file '${normPath}' was not found; skipping.`);
    return null;
  }
  if (isLikelyBinary(rawText)) {
    warnings.push(`Reference file '${normPath}' appears to be binary; skipping.`);
    return null;
  }

  const fingerprint = diskFingerprint ?? sha256Hex(rawText);
  if (cache && !input.forceRefresh) {
    const cached = cache.get(cacheKey, nowMs);
    if (cached.status === 'hit' && cached.meta.source_fingerprint === fingerprint) {
      return {
        id: metaOpts.id ?? normPath,
        title: metaOpts.title ?? cached.meta.title,
        source: normPath,
        kind: 'repo',
        mode: metaOpts.mode,
        content: cached.content,
        byte_length: cached.meta.byte_length,
        content_sha256: cached.meta.content_sha256,
        headings: cached.meta.headings,
        truncated: false,
        cache_status: 'hit',
      };
    }
  }

  const doc = finalizeNormalizedDoc(rawText, {
    id: metaOpts.id ?? normPath,
    ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
    source: normPath,
    kind: 'repo',
    mode: metaOpts.mode,
    maxDocBytes: input.config.max_doc_bytes,
    cacheStatus: cache ? 'miss' : 'uncached',
  });

  if (cache) {
    cache.set(
      cacheKey,
      {
        version: 1,
        key: cacheKey,
        source_id: doc.id,
        title: doc.title,
        kind: 'repo',
        content_sha256: doc.content_sha256,
        source_fingerprint: fingerprint,
        fetched_at: new Date(nowMs).toISOString(),
        ttl_seconds: ttl,
        byte_length: doc.byte_length,
        headings: doc.headings,
      },
      doc.content,
    );
  }
  return doc;
}

async function loadRemoteUrl(
  src: Extract<NormalizedSource, { kind: 'url' }>,
  input: LoadReferencesInput,
  cache: DiskReferenceCache | null,
  warnings: string[],
): Promise<RawLoadedDoc | null> {
  let url: URL;
  try {
    url = validateRemoteUrl(src.url);
  } catch (err) {
    warnings.push(`Rejected reference URL '${src.url}': ${(err as Error).message}`);
    return null;
  }

  const defaultId = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  const docId = src.id ?? defaultId;
  const cacheKey = `url:${url.toString()}`;
  const nowMs = input.nowMs ?? Date.now();
  const ttl = src.ttl_seconds ?? input.config.cache.ttl_seconds;

  let staleMeta: ReferenceCacheMeta | undefined;
  let staleContent: string | undefined;
  if (cache) {
    const lookup = cache.get(cacheKey, nowMs);
    if (lookup.status === 'hit' && !input.forceRefresh) {
      return {
        id: docId,
        title: src.title ?? lookup.meta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        content: lookup.content,
        byte_length: lookup.meta.byte_length,
        content_sha256: lookup.meta.content_sha256,
        headings: lookup.meta.headings,
        truncated: false,
        cache_status: 'hit',
      };
    }
    if (lookup.status === 'hit' || lookup.status === 'stale') {
      staleMeta = lookup.meta;
      staleContent = lookup.content;
    }
  }

  const fetchFn = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      Accept: 'text/markdown, text/plain, text/html, */*;q=0.5',
      'User-Agent': 'driches-vor/reference-loader',
    };
    if (!input.forceRefresh && staleMeta) {
      if (staleMeta.etag) headers['If-None-Match'] = staleMeta.etag;
      if (staleMeta.last_modified) headers['If-Modified-Since'] = staleMeta.last_modified;
    }

    const res = await fetchFn(url.toString(), {
      headers,
      signal: controller.signal,
    });

    if (res.status === 304 && staleMeta && staleContent !== undefined) {
      const nextEtag = res.headers.get('etag') ?? staleMeta.etag;
      const nextLastMod = res.headers.get('last-modified') ?? staleMeta.last_modified;
      cache?.touch(cacheKey, {
        fetched_at: new Date(nowMs).toISOString(),
        ttl_seconds: ttl,
        ...(nextEtag !== undefined ? { etag: nextEtag } : {}),
        ...(nextLastMod !== undefined ? { last_modified: nextLastMod } : {}),
      });
      return {
        id: docId,
        title: src.title ?? staleMeta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        content: staleContent,
        byte_length: staleMeta.byte_length,
        content_sha256: staleMeta.content_sha256,
        headings: staleMeta.headings,
        truncated: false,
        cache_status: 'revalidated',
      };
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (isLikelyBinary(buf)) {
      warnings.push(`Reference URL '${src.url}' returned binary content; skipping.`);
      return null;
    }
    const cappedRaw =
      buf.length > MAX_RAW_REMOTE_BYTES
        ? buf.subarray(0, MAX_RAW_REMOTE_BYTES).toString('utf-8')
        : buf.toString('utf-8');
    const contentType = res.headers.get('content-type') ?? undefined;
    const doc = finalizeNormalizedDoc(cappedRaw, {
      id: docId,
      ...(src.title !== undefined ? { explicitTitle: src.title } : {}),
      source: src.url,
      kind: 'url',
      mode: src.mode,
      maxDocBytes: input.config.max_doc_bytes,
      ...(contentType !== undefined ? { contentType } : {}),
      cacheStatus: cache ? 'miss' : 'uncached',
    });

    if (cache) {
      const etag = res.headers.get('etag') ?? undefined;
      const lastModified = res.headers.get('last-modified') ?? undefined;
      cache.set(
        cacheKey,
        {
          version: 1,
          key: cacheKey,
          source_id: doc.id,
          title: doc.title,
          kind: 'url',
          content_sha256: doc.content_sha256,
          ...(etag ? { etag } : {}),
          ...(lastModified ? { last_modified: lastModified } : {}),
          fetched_at: new Date(nowMs).toISOString(),
          ttl_seconds: ttl,
          byte_length: doc.byte_length,
          headings: doc.headings,
        },
        doc.content,
      );
    }
    return doc;
  } catch (err) {
    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(
        `Failed to fetch '${src.url}' (${(err as Error).message}); using stale cached copy.`,
      );
      return {
        id: docId,
        title: src.title ?? staleMeta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        content: staleContent,
        byte_length: staleMeta.byte_length,
        content_sha256: staleMeta.content_sha256,
        headings: staleMeta.headings,
        truncated: false,
        cache_status: 'stale-fallback',
      };
    }
    warnings.push(`Failed to fetch reference URL '${src.url}': ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadGithubFile(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  metaOpts: { id?: string; title?: string; mode: ReferenceMode; ttl_seconds?: number },
  input: LoadReferencesInput,
  cache: DiskReferenceCache | null,
  warnings: string[],
): Promise<RawLoadedDoc | null> {
  const normPath = normalizePath(filePath);
  const sourceLabel = `github:${owner}/${repo}/${normPath}@${ref}`;
  const docId = metaOpts.id ?? `github:${owner}/${repo}/${normPath}`;
  const cacheKey = `github:${owner}/${repo}@${ref}:${normPath}`;
  const nowMs = input.nowMs ?? Date.now();
  const ttl = metaOpts.ttl_seconds ?? input.config.cache.ttl_seconds;

  let staleMeta: ReferenceCacheMeta | undefined;
  let staleContent: string | undefined;
  if (cache) {
    const lookup = cache.get(cacheKey, nowMs);
    if (lookup.status === 'hit' && !input.forceRefresh) {
      return {
        id: docId,
        title: metaOpts.title ?? lookup.meta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        content: lookup.content,
        byte_length: lookup.meta.byte_length,
        content_sha256: lookup.meta.content_sha256,
        headings: lookup.meta.headings,
        truncated: false,
        cache_status: 'hit',
      };
    }
    if (lookup.status === 'hit' || lookup.status === 'stale') {
      staleMeta = lookup.meta;
      staleContent = lookup.content;
    }
  }

  if (!input.octokit?.rest?.repos?.getContent) {
    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(`No GitHub client available for '${sourceLabel}'; using cached copy.`);
      return {
        id: docId,
        title: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        content: staleContent,
        byte_length: staleMeta.byte_length,
        content_sha256: staleMeta.content_sha256,
        headings: staleMeta.headings,
        truncated: false,
        cache_status: 'stale-fallback',
      };
    }
    warnings.push(`Cannot fetch '${sourceLabel}' without an authenticated GitHub client.`);
    return null;
  }

  try {
    const res = await input.octokit.rest.repos.getContent({
      owner,
      repo,
      path: normPath,
      ref,
      ...(!input.forceRefresh && staleMeta?.etag
        ? { headers: { 'If-None-Match': staleMeta.etag } }
        : {}),
    });
    if (Array.isArray(res.data) || res.data.type !== 'file') {
      warnings.push(`GitHub reference '${sourceLabel}' is not a regular file; skipping.`);
      return null;
    }
    const buf = Buffer.from(res.data.content, res.data.encoding as BufferEncoding);
    if (isLikelyBinary(buf)) {
      warnings.push(`GitHub reference '${sourceLabel}' appears binary; skipping.`);
      return null;
    }
    const rawText = buf.toString('utf-8');
    const doc = finalizeNormalizedDoc(rawText, {
      id: docId,
      ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
      source: sourceLabel,
      kind: 'github',
      mode: metaOpts.mode,
      maxDocBytes: input.config.max_doc_bytes,
      cacheStatus: cache ? 'miss' : 'uncached',
    });

    if (cache) {
      const etag = (res as { headers?: Record<string, string | undefined> }).headers?.etag;
      cache.set(
        cacheKey,
        {
          version: 1,
          key: cacheKey,
          source_id: doc.id,
          title: doc.title,
          kind: 'github',
          content_sha256: doc.content_sha256,
          ...(etag ? { etag } : {}),
          source_fingerprint: res.data.sha,
          fetched_at: new Date(nowMs).toISOString(),
          ttl_seconds: ttl,
          byte_length: doc.byte_length,
          headings: doc.headings,
        },
        doc.content,
      );
    }
    return doc;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 304 && staleMeta && staleContent !== undefined) {
      cache?.touch(cacheKey, {
        fetched_at: new Date(nowMs).toISOString(),
        ttl_seconds: ttl,
      });
      return {
        id: docId,
        title: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        content: staleContent,
        byte_length: staleMeta.byte_length,
        content_sha256: staleMeta.content_sha256,
        headings: staleMeta.headings,
        truncated: false,
        cache_status: 'revalidated',
      };
    }

    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(
        `Failed to fetch '${sourceLabel}' (${(err as Error).message}); using stale cached copy.`,
      );
      return {
        id: docId,
        title: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        content: staleContent,
        byte_length: staleMeta.byte_length,
        content_sha256: staleMeta.content_sha256,
        headings: staleMeta.headings,
        truncated: false,
        cache_status: 'stale-fallback',
      };
    }

    warnings.push(`Failed to fetch '${sourceLabel}': ${(err as Error).message}`);
    return null;
  }
}

async function loadGithubSource(
  src: Extract<NormalizedSource, { kind: 'github' }>,
  input: LoadReferencesInput,
  cache: DiskReferenceCache | null,
  warnings: string[],
): Promise<RawLoadedDoc[]> {
  if (!hasGlobMeta(src.path)) {
    const single = await loadGithubFile(
      src.owner,
      src.repo,
      src.path,
      src.ref,
      {
        ...(src.id !== undefined ? { id: src.id } : {}),
        ...(src.title !== undefined ? { title: src.title } : {}),
        mode: src.mode,
        ...(src.ttl_seconds !== undefined ? { ttl_seconds: src.ttl_seconds } : {}),
      },
      input,
      cache,
      warnings,
    );
    return single ? [single] : [];
  }

  if (!input.octokit?.rest?.git?.getTree) {
    warnings.push(
      `Cannot expand GitHub glob '${src.rawSpec}' without an authenticated GitHub client.`,
    );
    return [];
  }

  try {
    const treeRes = await input.octokit.rest.git.getTree({
      owner: src.owner,
      repo: src.repo,
      tree_sha: src.ref,
      recursive: '1',
    });
    const matched = (treeRes.data.tree ?? [])
      .filter((item) => item.type === 'blob' && typeof item.path === 'string')
      .map((item) => normalizePath(item.path!))
      .filter((p) => matchesGlob(p, src.path))
      .sort();
    const out: RawLoadedDoc[] = [];
    for (const p of matched) {
      if (out.length >= input.config.max_docs) break;
      const doc = await loadGithubFile(
        src.owner,
        src.repo,
        p,
        src.ref,
        {
          mode: src.mode,
          ...(src.ttl_seconds !== undefined ? { ttl_seconds: src.ttl_seconds } : {}),
        },
        input,
        cache,
        warnings,
      );
      if (doc) out.push(doc);
    }
    return out;
  } catch (err) {
    warnings.push(`Failed to expand GitHub glob '${src.rawSpec}': ${(err as Error).message}`);
    return [];
  }
}

function deduplicateIds(docs: RawLoadedDoc[]): RawLoadedDoc[] {
  const seen = new Map<string, number>();
  return docs.map((doc) => {
    const count = seen.get(doc.id) ?? 0;
    seen.set(doc.id, count + 1);
    if (count === 0) return doc;
    return { ...doc, id: `${doc.id}-${count + 1}` };
  });
}

function allocatePlacements(
  rawDocs: RawLoadedDoc[],
  maxInlineBytes: number,
  warnings: string[],
): LoadedReferenceDoc[] {
  let inlineBytes = 0;
  const placements = new Array<'inline' | 'on_demand'>(rawDocs.length).fill('on_demand');

  // Pass 1: explicit `mode: 'inline'` sources get priority within budget.
  for (let i = 0; i < rawDocs.length; i++) {
    const d = rawDocs[i]!;
    if (d.mode !== 'inline') continue;
    if (inlineBytes + d.byte_length <= maxInlineBytes) {
      placements[i] = 'inline';
      inlineBytes += d.byte_length;
    } else {
      warnings.push(
        `Reference '${d.id}' (${d.byte_length} bytes) exceeds remaining inline budget (${maxInlineBytes - inlineBytes} bytes); serving on-demand via read_reference_doc.`,
      );
    }
  }

  // Pass 2: `mode: 'auto'` sources fill remaining inline budget in order; overflow moves on-demand.
  for (let i = 0; i < rawDocs.length; i++) {
    const d = rawDocs[i]!;
    if (d.mode !== 'auto') continue;
    if (inlineBytes + d.byte_length <= maxInlineBytes) {
      placements[i] = 'inline';
      inlineBytes += d.byte_length;
    }
  }

  return rawDocs.map((d, i) => ({
    id: d.id,
    title: d.title,
    source: d.source,
    kind: d.kind,
    placement: placements[i]!,
    content: d.content,
    byte_length: d.byte_length,
    content_sha256: d.content_sha256,
    headings: d.headings,
    truncated: d.truncated,
    cache_status: d.cache_status,
  }));
}

export async function loadReferences(input: LoadReferencesInput): Promise<LoadedReferenceCorpus> {
  const cacheDir = resolveReferenceCacheDir(input.config.cache.dir, input.workspaceDir);
  const cache = input.config.cache.enabled ? new DiskReferenceCache(cacheDir) : null;
  const warnings: string[] = [];
  const rawDocs: RawLoadedDoc[] = [];

  if (!input.config.enabled || input.config.sources.length === 0) {
    return {
      docs: [],
      inline_docs: [],
      on_demand_docs: [],
      total_inline_bytes: 0,
      total_bytes: 0,
      corpus_digest: sha256Hex('empty'),
      cache_dir: cacheDir,
      cache_stats: { hits: 0, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
      warnings: [],
    };
  }

  let capHit = false;
  for (const entry of input.config.sources) {
    if (rawDocs.length >= input.config.max_docs) {
      capHit = true;
      break;
    }
    const src = normalizeSourceInput(entry, warnings);
    if (!src) continue;

    if (src.kind === 'repo-file') {
      const doc = await loadRepoFile(
        src.path,
        {
          ...(src.id !== undefined ? { id: src.id } : {}),
          ...(src.title !== undefined ? { title: src.title } : {}),
          mode: src.mode,
          ...(src.ttl_seconds !== undefined ? { ttl_seconds: src.ttl_seconds } : {}),
        },
        input,
        cache,
        warnings,
      );
      if (doc) rawDocs.push(doc);
    } else if (src.kind === 'repo-glob') {
      const matched = await listRepoGlobFiles(src.glob, input, warnings);
      if (matched.length === 0) {
        warnings.push(`Reference glob '${src.glob}' matched 0 files.`);
      }
      for (const path of matched) {
        if (rawDocs.length >= input.config.max_docs) {
          capHit = true;
          break;
        }
        const doc = await loadRepoFile(
          path,
          {
            mode: src.mode,
            ...(src.ttl_seconds !== undefined ? { ttl_seconds: src.ttl_seconds } : {}),
          },
          input,
          cache,
          warnings,
        );
        if (doc) rawDocs.push(doc);
      }
    } else if (src.kind === 'url') {
      const doc = await loadRemoteUrl(src, input, cache, warnings);
      if (doc) rawDocs.push(doc);
    } else if (src.kind === 'github') {
      const ghDocs = await loadGithubSource(src, input, cache, warnings);
      for (const d of ghDocs) {
        if (rawDocs.length >= input.config.max_docs) {
          capHit = true;
          break;
        }
        rawDocs.push(d);
      }
    }
  }

  if (capHit) {
    warnings.push(
      `Reference docs reached max_docs=${input.config.max_docs}; remaining files skipped.`,
    );
  }

  const uniqueDocs = deduplicateIds(rawDocs);
  const docs = allocatePlacements(uniqueDocs, input.config.max_inline_bytes, warnings);
  const inline_docs = docs.filter((d) => d.placement === 'inline');
  const on_demand_docs = docs.filter((d) => d.placement === 'on_demand');
  const total_inline_bytes = inline_docs.reduce((s, d) => s + d.byte_length, 0);
  const total_bytes = docs.reduce((s, d) => s + d.byte_length, 0);

  const cache_stats = { hits: 0, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 };
  for (const d of docs) {
    if (d.cache_status === 'hit') cache_stats.hits += 1;
    else if (d.cache_status === 'revalidated') cache_stats.revalidated += 1;
    else if (d.cache_status === 'miss') cache_stats.misses += 1;
    else if (d.cache_status === 'stale-fallback') cache_stats.stale_fallbacks += 1;
    else cache_stats.uncached += 1;
  }

  const digestInput = [...docs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => `${d.id}:${d.placement}:${d.content_sha256}`)
    .join('\n');
  const corpus_digest = sha256Hex(digestInput || 'empty');

  return {
    docs,
    inline_docs,
    on_demand_docs,
    total_inline_bytes,
    total_bytes,
    corpus_digest,
    cache_dir: cacheDir,
    cache_stats,
    warnings,
  };
}
