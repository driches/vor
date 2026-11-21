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
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
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

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface HttpFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
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
  lookupImpl?: DnsLookupFn;
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
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
  '169.254.170.2',
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
  const lastAt = rest.lastIndexOf('@');
  // Treat `@` as a ref delimiter unless it starts a path segment (e.g. `packages/@scope/foo.md`)
  // or produces an empty path or ref.
  if (lastAt > 0 && rest[lastAt - 1] !== '/' && lastAt < rest.length - 1) {
    const path = rest.slice(0, lastAt);
    const ref = rest.slice(lastAt + 1);
    if (path && ref && !ref.startsWith('/')) {
      return { owner, repo, path, ref };
    }
    return null;
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

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function parseIpv6GroupSide(raw: string, allowTrailingIpv4: boolean): number[] | null {
  if (!raw) return [];
  const tokens = raw.split(':');
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok) return null;
    if (tok.includes('.')) {
      if (!allowTrailingIpv4 || i !== tokens.length - 1) return null;
      const octets = parseIpv4Octets(tok);
      if (!octets) return null;
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(tok)) return null;
      out.push(Number.parseInt(tok, 16));
    }
  }
  return out;
}

function parseIpv6Hextets(addr: string): number[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const hextets = parseIpv6GroupSide(halves[0]!, true);
    return hextets && hextets.length === 8 ? hextets : null;
  }
  const left = parseIpv6GroupSide(halves[0]!, false);
  const right = parseIpv6GroupSide(halves[1]!, true);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function stripIpv6Brackets(rawHostname: string): string {
  const lower = rawHostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function isPrivateOrLoopbackHost(rawHostname: string): boolean {
  const trimmed = rawHostname.toLowerCase().replace(/\.$/, '');
  const unbracketed = stripIpv6Brackets(trimmed);
  // Strip IPv6 zone identifier (e.g. `fe80::1%eth0` / `fe80::1%25eth0`).
  const host = unbracketed.split('%')[0] ?? unbracketed;

  if (BLOCKED_METADATA_HOSTS.has(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isBlockedIpv4(host)) return true;

  if (host.includes(':')) {
    const h = parseIpv6Hextets(host);
    if (!h) return true; // Fail closed on unparseable IPv6 literals.

    const allZeroFirst6 =
      h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
    const allZeroFirst7 = allZeroFirst6 && h[6] === 0;
    if (allZeroFirst7 && (h[7] === 0 || h[7] === 1)) {
      return true; // Unspecified (::) and loopback (::1)
    }

    const embeddedV4 = `${(h[6]! >> 8) & 0xff}.${h[6]! & 0xff}.${(h[7]! >> 8) & 0xff}.${h[7]! & 0xff}`;
    const isIpv4Mapped =
      h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff;
    const isIpv4Translated =
      h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0;
    const isIpv4Compatible = allZeroFirst6;
    const isNat64WellKnown =
      h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;

    if (
      (isIpv4Mapped || isIpv4Translated || isIpv4Compatible || isNat64WellKnown) &&
      isBlockedIpv4(embeddedV4)
    ) {
      return true;
    }

    // NAT64 local-use (64:ff9b:1::/48) and discard-only (100::/64)
    if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true;
    if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;

    const h0 = h[0]!;
    // fe80::/10 (link-local), fec0::/10 (deprecated site-local), fc00::/7 (unique local), ff00::/8 (multicast)
    if ((h0 & 0xffc0) === 0xfe80) return true;
    if ((h0 & 0xffc0) === 0xfec0) return true;
    if ((h0 & 0xfe00) === 0xfc00) return true;
    if ((h0 & 0xff00) === 0xff00) return true;
  }

  return false;
}

function validateRemoteUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme '${url.protocol}'`);
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    throw new Error(`Blocked host '${host}'`);
  }
  return url;
}

async function defaultDnsLookup(hostname: string): Promise<ResolvedAddress[]> {
  const entries = await dnsLookup(hostname, { all: true });
  return entries.map((e) => ({
    address: e.address,
    family: e.family === 6 ? 6 : 4,
  }));
}

async function resolveAndValidateHost(url: URL, lookupFn: DnsLookupFn): Promise<ResolvedAddress[]> {
  const rawHost = stripIpv6Brackets(url.hostname);
  const ipVer = isIP(rawHost);
  if (ipVer === 4 || ipVer === 6) {
    if (isPrivateOrLoopbackHost(rawHost)) {
      throw new Error(`Blocked host '${rawHost}'`);
    }
    return [{ address: rawHost, family: ipVer }];
  }

  const records = await lookupFn(rawHost);
  if (!records || records.length === 0) {
    throw new Error(`DNS lookup returned no addresses for '${rawHost}'`);
  }
  for (const rec of records) {
    if (isPrivateOrLoopbackHost(rec.address)) {
      throw new Error(
        `Blocked host '${rawHost}' (resolved to restricted address '${rec.address}')`,
      );
    }
  }
  return records;
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
  if (input.octokit?.rest?.git?.getTree && input.owner && input.repo && input.ref) {
    try {
      const r = await input.octokit.rest.git.getTree({
        owner: input.owner,
        repo: input.repo,
        tree_sha: input.ref,
        recursive: '1',
      });
      if (r.data.truncated) {
        warnings.push(
          `GitHub tree for '${pattern}' at ${input.ref} was truncated (repo too large); glob may miss files.`,
        );
      }
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

  if (input.workspaceDir && existsSync(input.workspaceDir)) {
    const files = enumerateWorkspaceFiles(input.workspaceDir);
    const matched = files.filter((f) => matchesGlob(f, pattern)).sort();
    if (matched.length > 0) return matched;
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

function materializeNormalizedDoc(
  normalized: string,
  opts: {
    id: string;
    explicitTitle?: string;
    source: string;
    kind: 'repo' | 'url' | 'github';
    mode: ReferenceMode;
    maxDocBytes: number;
    cacheStatus: ReferenceCacheStatus;
  },
): RawLoadedDoc {
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

function writeNormalizedCacheEntry(
  cache: DiskReferenceCache,
  cacheKey: string,
  normalized: string,
  meta: {
    id: string;
    explicitTitle?: string;
    source: string;
    kind: 'repo' | 'url' | 'github';
    nowMs: number;
    ttlSeconds: number;
    etag?: string;
    lastModified?: string;
    sourceFingerprint?: string;
  },
): void {
  // Persist the full untruncated normalized document so later loads can
  // change `max_doc_bytes` and re-apply truncation cleanly on cache hits.
  cache.set(
    cacheKey,
    {
      version: 1,
      key: cacheKey,
      source_id: meta.id,
      title: inferTitle(meta.explicitTitle, normalized, meta.source),
      kind: meta.kind,
      content_sha256: sha256Hex(normalized),
      ...(meta.etag ? { etag: meta.etag } : {}),
      ...(meta.lastModified ? { last_modified: meta.lastModified } : {}),
      ...(meta.sourceFingerprint ? { source_fingerprint: meta.sourceFingerprint } : {}),
      fetched_at: new Date(meta.nowMs).toISOString(),
      ttl_seconds: meta.ttlSeconds,
      byte_length: Buffer.byteLength(normalized, 'utf-8'),
      headings: extractDocumentHeadings(normalized),
    },
    normalized,
  );
}

type SafeWorkspaceFileResult =
  | { status: 'ok'; realPath: string }
  | { status: 'missing' }
  | { status: 'escape' | 'broken_symlink' };

/**
 * Resolves `relPath` inside `workspaceDir` and rejects symlinks (including
 * symlinked parent directories) whose real target leaves `workspaceDir`.
 */
function resolveSafeWorkspaceFile(workspaceDir: string, relPath: string): SafeWorkspaceFileResult {
  if (!isSafeRelativePath(workspaceDir, relPath)) {
    return { status: 'escape' };
  }
  const abs = resolve(workspaceDir, relPath);
  try {
    lstatSync(abs);
  } catch {
    return { status: 'missing' }; // file does not exist on disk
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(workspaceDir);
    realTarget = realpathSync(abs);
  } catch {
    return { status: 'broken_symlink' };
  }

  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { status: 'escape' };
  }
  return { status: 'ok', realPath: realTarget };
}

function buildRepoCacheHit(
  cached: { content: string; meta: ReferenceCacheMeta },
  docId: string,
  normPath: string,
  metaOpts: { title?: string; mode: ReferenceMode },
  maxDocBytes: number,
): RawLoadedDoc {
  return materializeNormalizedDoc(cached.content, {
    id: docId,
    explicitTitle: metaOpts.title ?? cached.meta.title,
    source: normPath,
    kind: 'repo',
    mode: metaOpts.mode,
    maxDocBytes,
    cacheStatus: 'hit',
  });
}

function canonicalWorkspaceId(workspaceDir: string): string {
  const resolved = resolve(workspaceDir);
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    // Workspace directory may not exist yet or realpath may fail; fall back to resolved path.
  }
  return sha256Hex(canonical).slice(0, 32);
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
  const hasRemoteRef = Boolean(input.fileReader && input.owner && input.repo && input.ref);
  const repoSlug = `${input.owner ?? 'local'}/${input.repo ?? 'local'}`;
  const cacheKey = hasRemoteRef
    ? `repo:${repoSlug}:${normPath}@${input.ref}`
    : `repo:${repoSlug}:ws:${canonicalWorkspaceId(baseDir)}:${normPath}`;
  const nowMs = input.nowMs ?? Date.now();
  const ttl = metaOpts.ttl_seconds ?? input.config.cache.ttl_seconds;
  const docId = metaOpts.id ?? normPath;

  let diskPath: string | null = null;
  let diskFingerprint: string | undefined;
  if (input.workspaceDir) {
    const resolvedFile = resolveSafeWorkspaceFile(input.workspaceDir, normPath);
    if (resolvedFile.status === 'escape') {
      warnings.push(
        `Reference path '${normPath}' resolves outside workspace root via symlink; skipping.`,
      );
      return null;
    }
    if (resolvedFile.status === 'broken_symlink') {
      warnings.push(`Reference path '${normPath}' is a broken symlink; skipping.`);
      return null;
    }
    if (resolvedFile.status === 'ok') {
      try {
        const st = statSync(resolvedFile.realPath);
        if (st.isFile()) {
          diskPath = resolvedFile.realPath;
          diskFingerprint = `disk:${st.ino}:${st.mtimeMs}:${st.size}`;
        }
      } catch {
        // Fall through when local file cannot be stat'd directly.
      }
    }
  }

  if (hasRemoteRef) {
    // Serve a cache hit for this exact `ref` only when either the cached entry
    // came from API content (`ref:...`) or its disk fallback still matches the
    // verified workspace file.
    if (cache && !input.forceRefresh) {
      const cached = cache.get(cacheKey, nowMs);
      if (cached.status === 'hit') {
        const fp = cached.meta.source_fingerprint ?? '';
        const refMatch = fp.startsWith(`ref:${input.ref}:`);
        const diskMatch =
          Boolean(diskFingerprint) && fp.startsWith('disk:') && fp === diskFingerprint;
        if (refMatch || diskMatch) {
          return buildRepoCacheHit(cached, docId, normPath, metaOpts, input.config.max_doc_bytes);
        }
      }
    }

    let remoteText: string | null = null;
    try {
      remoteText = await input.fileReader!.read({
        owner: input.owner!,
        repo: input.repo!,
        path: normPath,
        ref: input.ref!,
      });
    } catch {
      remoteText = null; // fall back to local workspace file when Contents API read fails
    }

    if (remoteText !== null) {
      if (isLikelyBinary(remoteText)) {
        warnings.push(`Reference file '${normPath}' appears to be binary; skipping.`);
        return null;
      }
      const fingerprint = `ref:${input.ref}:${sha256Hex(remoteText)}`;
      const normalized = normalizeDocumentText(remoteText);
      if (cache) {
        writeNormalizedCacheEntry(cache, cacheKey, normalized, {
          id: docId,
          ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
          source: normPath,
          kind: 'repo',
          nowMs,
          ttlSeconds: ttl,
          sourceFingerprint: fingerprint,
        });
      }
      return materializeNormalizedDoc(normalized, {
        id: docId,
        ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
        source: normPath,
        kind: 'repo',
        mode: metaOpts.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: cache ? 'miss' : 'uncached',
      });
    }
  } else if (cache && !input.forceRefresh && diskFingerprint) {
    const cached = cache.get(cacheKey, nowMs);
    if (cached.status === 'hit' && cached.meta.source_fingerprint === diskFingerprint) {
      return buildRepoCacheHit(cached, docId, normPath, metaOpts, input.config.max_doc_bytes);
    }
  }

  let diskContent: string | null = null;
  if (diskPath) {
    try {
      const buf = readFileSync(diskPath);
      if (isLikelyBinary(buf)) {
        warnings.push(`Reference file '${normPath}' appears to be binary; skipping.`);
        return null;
      }
      diskContent = buf.toString('utf-8');
    } catch {
      diskContent = null; // unable to read local file
    }
  }

  if (diskContent === null) {
    warnings.push(`Reference file '${normPath}' was not found; skipping.`);
    return null;
  }

  const fingerprint = diskFingerprint ?? `sha:${sha256Hex(diskContent)}`;
  const normalized = normalizeDocumentText(diskContent);
  if (cache) {
    writeNormalizedCacheEntry(cache, cacheKey, normalized, {
      id: docId,
      ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
      source: normPath,
      kind: 'repo',
      nowMs,
      ttlSeconds: ttl,
      sourceFingerprint: fingerprint,
    });
  }
  return materializeNormalizedDoc(normalized, {
    id: docId,
    ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
    source: normPath,
    kind: 'repo',
    mode: metaOpts.mode,
    maxDocBytes: input.config.max_doc_bytes,
    cacheStatus: cache ? 'miss' : 'uncached',
  });
}

async function readResponseWithByteLimit(
  res: HttpFetchResponse,
  maxBytes: number,
): Promise<Buffer> {
  if (!res.body) {
    if (!res.arrayBuffer) return Buffer.alloc(0);
    // Some minimal fetch polyfills and streamless responses omit `res.body`, so
    // no ReadableStream exists to cancel; buffer the response once and slice
    // strictly to `maxBytes`.
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        // Stop streaming immediately once the cap is reached so oversized
        // responses are never buffered in memory in full.
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

/**
 * Perform a GET request pinned to pre-validated IP addresses via a custom socket
 * `lookup`, preventing DNS rebinding between validation and TCP/TLS connect.
 */
export function pinnedNodeFetch(
  url: URL,
  addresses: readonly ResolvedAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<HttpFetchResponse> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  }

  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    process.nextTick(() => {
      if (options?.all) {
        callback(
          null,
          addresses.map((a) => ({ address: a.address, family: a.family })),
        );
        return;
      }
      const picked =
        (options?.family ? addresses.find((a) => a.family === options.family) : undefined) ??
        addresses[0]!;
      callback(null, picked.address, picked.family);
    });
  };

  const isHttps = url.protocol === 'https:';
  const rawHost = stripIpv6Brackets(url.hostname);
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') reqHeaders[k] = v;
  }
  reqHeaders.Host = url.host;
  reqHeaders['Accept-Encoding'] = 'identity';

  const baseOpts: http.RequestOptions = {
    protocol: url.protocol,
    hostname: rawHost,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: reqHeaders,
    agent: false,
    signal,
    lookup: pinnedLookup,
  };

  return new Promise<HttpFetchResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let onStreamError: ((err: Error) => void) | null = null;

    const req = isHttps
      ? https.request({
          ...baseOpts,
          ...(isIP(rawHost) === 0 ? { servername: rawHost } : {}),
        })
      : http.request(baseOpts);

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      } else {
        onStreamError?.(err);
      }
    });

    req.on('response', (incoming) => {
      settled = true;
      const status = incoming.statusCode ?? 0;
      const statusText = incoming.statusMessage ?? '';
      const ok = status >= 200 && status < 300;

      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) resHeaders.append(k, item);
        } else {
          resHeaders.set(k, v);
        }
      }

      if (REDIRECT_STATUSES.has(status) || status === 204 || status === 304) {
        incoming.destroy();
        resolvePromise({ status, statusText, ok, headers: resHeaders, body: null });
        return;
      }

      const encoding = (incoming.headers['content-encoding'] ?? '').trim().toLowerCase();
      let stream: Readable = incoming;
      let decompressor: Transform | null = null;
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        decompressor = createGunzip();
        stream = incoming.pipe(decompressor);
      } else if (encoding === 'deflate') {
        decompressor = createInflate();
        stream = incoming.pipe(decompressor);
      } else if (encoding === 'br') {
        decompressor = createBrotliDecompress();
        stream = incoming.pipe(decompressor);
      }

      let closedOrErrored = false;
      let removeAbortListener: () => void = () => {};

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const teardown = () => {
            removeAbortListener();
            decompressor?.destroy();
            incoming.destroy();
            req.destroy();
          };
          const fail = (err: Error) => {
            if (closedOrErrored) return;
            closedOrErrored = true;
            teardown();
            try {
              controller.error(err);
            } catch {
              // controller already settled
            }
          };
          onStreamError = fail;
          const onAbort = () => {
            fail(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);

          if (decompressor) incoming.on('error', fail);
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            if (closedOrErrored) return;
            controller.enqueue(new Uint8Array(chunk));
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              stream.pause();
            }
          });
          stream.on('end', () => {
            if (closedOrErrored) return;
            closedOrErrored = true;
            removeAbortListener();
            try {
              controller.close();
            } catch {
              // controller already settled
            }
          });
          incoming.on('aborted', () => {
            if (!closedOrErrored) {
              fail(new Error('Response aborted before completion'));
            }
          });
        },
        pull() {
          stream.resume();
        },
        cancel() {
          if (closedOrErrored) return;
          closedOrErrored = true;
          removeAbortListener();
          decompressor?.destroy();
          incoming.destroy();
          req.destroy();
        },
      });

      resolvePromise({ status, statusText, ok, headers: resHeaders, body });
    });

    req.end();
  });
}

async function fetchWithValidatedRedirects(
  transport: { fetchImpl?: typeof fetch; lookupImpl?: DnsLookupFn },
  initialUrl: URL,
  baseHeaders: Record<string, string>,
  conditionalHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<HttpFetchResponse> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const sameOrigin = currentUrl.origin === initialUrl.origin;
    const reqHeaders: Record<string, string> = {
      ...baseHeaders,
      ...(sameOrigin ? conditionalHeaders : {}),
    };
    let res: HttpFetchResponse;
    if (transport.fetchImpl === undefined) {
      const addresses = await resolveAndValidateHost(
        currentUrl,
        transport.lookupImpl ?? defaultDnsLookup,
      );
      res = await pinnedNodeFetch(currentUrl, addresses, reqHeaders, signal);
    } else {
      if (transport.lookupImpl !== undefined) {
        await resolveAndValidateHost(currentUrl, transport.lookupImpl);
      }
      res = await transport.fetchImpl(currentUrl.toString(), {
        headers: reqHeaders,
        redirect: 'manual',
        signal,
      });
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      void res.body?.cancel?.();
      if (!location) {
        throw new Error(`Redirect (${res.status}) missing Location header`);
      }
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`Exceeded maximum redirect limit (${MAX_REDIRECTS})`);
      }
      const nextRaw = new URL(location, currentUrl).toString();
      currentUrl = validateRemoteUrl(nextRaw);
      continue;
    }
    return res;
  }
  throw new Error(`Exceeded maximum redirect limit (${MAX_REDIRECTS})`);
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
      return materializeNormalizedDoc(lookup.content, {
        id: docId,
        explicitTitle: src.title ?? lookup.meta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'hit',
      });
    }
    if (lookup.status === 'hit' || lookup.status === 'stale') {
      staleMeta = lookup.meta;
      staleContent = lookup.content;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const baseHeaders: Record<string, string> = {
      Accept: 'text/markdown, text/plain, text/html, */*;q=0.5',
      'User-Agent': 'driches-vor/reference-loader',
    };
    const conditionalHeaders: Record<string, string> = {};
    if (!input.forceRefresh && staleMeta) {
      if (staleMeta.etag) conditionalHeaders['If-None-Match'] = staleMeta.etag;
      if (staleMeta.last_modified)
        conditionalHeaders['If-Modified-Since'] = staleMeta.last_modified;
    }

    const res = await fetchWithValidatedRedirects(
      {
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.lookupImpl ? { lookupImpl: input.lookupImpl } : {}),
      },
      url,
      baseHeaders,
      conditionalHeaders,
      controller.signal,
    );

    if (res.status === 304 && staleMeta && staleContent !== undefined) {
      void res.body?.cancel?.();
      const nextEtag = res.headers.get('etag') ?? staleMeta.etag;
      const nextLastMod = res.headers.get('last-modified') ?? staleMeta.last_modified;
      cache?.touch(cacheKey, {
        fetched_at: new Date(nowMs).toISOString(),
        ttl_seconds: ttl,
        ...(nextEtag !== undefined ? { etag: nextEtag } : {}),
        ...(nextLastMod !== undefined ? { last_modified: nextLastMod } : {}),
      });
      return materializeNormalizedDoc(staleContent, {
        id: docId,
        explicitTitle: src.title ?? staleMeta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'revalidated',
      });
    }

    if (!res.ok) {
      void res.body?.cancel?.();
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const buf = await readResponseWithByteLimit(res, MAX_RAW_REMOTE_BYTES);
    if (isLikelyBinary(buf)) {
      warnings.push(`Reference URL '${src.url}' returned binary content; skipping.`);
      return null;
    }
    const cappedRaw = buf.toString('utf-8');
    const contentType = res.headers.get('content-type') ?? undefined;
    const normalized = normalizeDocumentText(cappedRaw, contentType);

    if (cache) {
      const etag = res.headers.get('etag') ?? undefined;
      const lastModified = res.headers.get('last-modified') ?? undefined;
      writeNormalizedCacheEntry(cache, cacheKey, normalized, {
        id: docId,
        ...(src.title !== undefined ? { explicitTitle: src.title } : {}),
        source: src.url,
        kind: 'url',
        nowMs,
        ttlSeconds: ttl,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      });
    }
    return materializeNormalizedDoc(normalized, {
      id: docId,
      ...(src.title !== undefined ? { explicitTitle: src.title } : {}),
      source: src.url,
      kind: 'url',
      mode: src.mode,
      maxDocBytes: input.config.max_doc_bytes,
      cacheStatus: cache ? 'miss' : 'uncached',
    });
  } catch (err) {
    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(
        `Failed to fetch '${src.url}' (${(err as Error).message}); using stale cached copy.`,
      );
      return materializeNormalizedDoc(staleContent, {
        id: docId,
        explicitTitle: src.title ?? staleMeta.title,
        source: src.url,
        kind: 'url',
        mode: src.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'stale-fallback',
      });
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
      return materializeNormalizedDoc(lookup.content, {
        id: docId,
        explicitTitle: metaOpts.title ?? lookup.meta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'hit',
      });
    }
    if (lookup.status === 'hit' || lookup.status === 'stale') {
      staleMeta = lookup.meta;
      staleContent = lookup.content;
    }
  }

  if (!input.octokit?.rest?.repos?.getContent) {
    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(`No GitHub client available for '${sourceLabel}'; using cached copy.`);
      return materializeNormalizedDoc(staleContent, {
        id: docId,
        explicitTitle: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'stale-fallback',
      });
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
    const normalized = normalizeDocumentText(rawText);

    if (cache) {
      // Octokit's `repos.getContent` union return type omits `etag` on its
      // typed response headers map even though Octokit populates `headers.etag`;
      // safely fall back to `undefined` (no conditional request) if absent.
      const etag = (res as { headers?: Record<string, string | undefined> }).headers?.etag;
      writeNormalizedCacheEntry(cache, cacheKey, normalized, {
        id: docId,
        ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
        source: sourceLabel,
        kind: 'github',
        nowMs,
        ttlSeconds: ttl,
        ...(etag ? { etag } : {}),
        sourceFingerprint: res.data.sha,
      });
    }
    return materializeNormalizedDoc(normalized, {
      id: docId,
      ...(metaOpts.title !== undefined ? { explicitTitle: metaOpts.title } : {}),
      source: sourceLabel,
      kind: 'github',
      mode: metaOpts.mode,
      maxDocBytes: input.config.max_doc_bytes,
      cacheStatus: cache ? 'miss' : 'uncached',
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 304 && staleMeta && staleContent !== undefined) {
      cache?.touch(cacheKey, {
        fetched_at: new Date(nowMs).toISOString(),
        ttl_seconds: ttl,
      });
      return materializeNormalizedDoc(staleContent, {
        id: docId,
        explicitTitle: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'revalidated',
      });
    }

    if (staleMeta && staleContent !== undefined && input.config.cache.stale_on_error) {
      warnings.push(
        `Failed to fetch '${sourceLabel}' (${(err as Error).message}); using stale cached copy.`,
      );
      return materializeNormalizedDoc(staleContent, {
        id: docId,
        explicitTitle: metaOpts.title ?? staleMeta.title,
        source: sourceLabel,
        kind: 'github',
        mode: metaOpts.mode,
        maxDocBytes: input.config.max_doc_bytes,
        cacheStatus: 'stale-fallback',
      });
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
    if (treeRes.data.truncated) {
      warnings.push(
        `GitHub tree for '${src.rawSpec}' was truncated (repo too large); glob may miss files.`,
      );
    }
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
    // 1-indexed occurrence numbering: first keeps its bare id (#1), second gets
    // "-2", third "-3", and so on.
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
