/**
 * Glob matching, specificity ranking, bounded-context capture, and test-path
 * classification for architecture boundary enforcement.
 *
 * Intentionally zero-dependency so the action bundle stays lean.
 */

export interface ContextMatch {
  /** Captured context / module identifier (e.g. `billing`). */
  context: string;
  /** Repo-relative root path of this context instance (e.g. `src/contexts/billing`). */
  contextRoot: string;
  /** Path inside `contextRoot`, or `''` when `filePath` is the root itself. */
  relativePath: string;
}

const MAX_REGEX_CACHE = 512;
const MAX_CONTEXT_REGEX_CACHE = 128;
const regexCache = new Map<string, RegExp>();

function setBounded<V>(
  cache: Map<string, V>,
  key: string,
  value: V,
  limit = MAX_REGEX_CACHE,
): void {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Normalize path separators, strip leading `./` or `/` and redundant slashes. */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function escapeRegexChar(ch: string): string {
  return /[\\^$+?.()|{}[\]]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile a glob body (without `^`/`$` anchors) into a regex source string.
 * Supports double-star directory globs, `*`, `?`, and single-level `{a,b,c}` brace groups.
 */
function compileGlobBody(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close !== -1) {
        const inner = pattern.slice(i + 1, close);
        const parts = inner.split(',').map((p) => compileGlobBody(p));
        out += `(?:${parts.join('|')})`;
        i = close;
        continue;
      }
    }
    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        const atSegStart = i === 0 || pattern[i - 1] === '/';
        const after = pattern[i + 2];
        if (atSegStart && after === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else if (atSegStart && after === undefined) {
          out += '.*';
          i += 1;
        } else {
          // `**` not occupying a full path segment (e.g. `src/domain**` or `src/**helper`)
          // collapses to single-segment `*` so it cannot cross `/` separators.
          out += '[^/]*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegexChar(ch);
  }
  return out;
}

/** Compile a repo-relative glob pattern to a RegExp (memoized). */
export function globToRegExp(pattern: string): RegExp {
  const norm = normalizePath(pattern);
  const cached = regexCache.get(norm);
  if (cached) return cached;

  const re = new RegExp(`^${compileGlobBody(norm)}$`);
  setBounded(regexCache, norm, re);
  return re;
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const norm = normalizePath(filePath);
  if (!norm) return false;
  return globToRegExp(pattern).test(norm);
}

export function matchesAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const norm = normalizePath(filePath);
  if (!norm) return false;
  return patterns.some((p) => globToRegExp(p).test(norm));
}

// Rank glob specificity so narrower nested rules (e.g. adapters/in or
// application/ports) win over broader parent rules (adapters, application)
// regardless of key order.
export function globSpecificity(pattern: string): number {
  const norm = normalizePath(pattern);
  const segments = norm.split('/').filter(Boolean);
  let literalSegments = 0;
  let wildcardSegments = 0;
  for (const seg of segments) {
    if (seg === '**') continue;
    if (seg.includes('*') || seg.includes('?') || seg.includes('{')) {
      wildcardSegments += 1;
    } else {
      literalSegments += 1;
    }
  }
  const literalChars = norm.replace(/[*?{}/,]/g, '').length;
  return literalSegments * 100 + wildcardSegments * 10 + literalChars;
}

const contextRegexCache = new Map<string, RegExp | null>();

function buildContextRegex(pattern: string): RegExp | null {
  let norm = normalizePath(pattern);
  if (norm.endsWith('/**')) {
    norm = norm.slice(0, -3);
  }
  const cached = contextRegexCache.get(norm);
  if (cached !== undefined) return cached;

  const segments = norm.split('/').filter(Boolean);
  const starIdx = segments.indexOf('*');
  if (starIdx === -1) {
    setBounded(contextRegexCache, norm, null, MAX_CONTEXT_REGEX_CACHE);
    return null;
  }

  const prefixSegments = segments.slice(0, starIdx);
  const suffixSegments = segments.slice(starIdx + 1);

  const compileSegmentPrefix = (segs: string[]): string => {
    if (segs.length === 0) return '';
    // Use non-greedy `.*?` for `**` before the context directory so nested
    // occurrences inside a module (e.g. `modules/orders/modules/sub.ts`) still
    // bind to the outermost context (`orders`).
    const parts = segs.map((s) => (s === '**' ? '(?:.*?/)?' : `${compileGlobBody(s)}/`));
    return parts.join('');
  };

  const prefixBody = compileSegmentPrefix(prefixSegments);
  const suffixBody =
    suffixSegments.length > 0 ? `/${suffixSegments.map((s) => compileGlobBody(s)).join('/')}` : '';

  const re = new RegExp(`^(${prefixBody}([^/]+)${suffixBody})(?:/(.*))?$`);
  setBounded(contextRegexCache, norm, re, MAX_CONTEXT_REGEX_CACHE);
  return re;
}

// Extract the bounded-context / module name for `filePath` using a context
// pattern such as `src/contexts/*`, `**/contexts/*`, or `packages/*/src`.
export function extractContext(filePath: string, pattern: string): ContextMatch | null {
  const norm = normalizePath(filePath);
  if (!norm) return null;
  const re = buildContextRegex(pattern);
  if (!re) return null;
  const m = norm.match(re);
  if (!m || !m[1] || !m[2]) return null;
  return {
    contextRoot: m[1],
    context: m[2],
    relativePath: m[3] ?? '',
  };
}

const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:__tests__|tests?|spec|specs)\//i,
  /\.(?:test|spec)\.[^/]+$/i,
  /_test\.(?:go|py|rs|dart)$/i,
  /(?:^|\/)test_[^/]+\.py$/i,
  /(?:Test|Tests|Spec)\.(?:java|kt|kts|cs)$/,
];

/** True for test/spec files across supported languages. */
export function isTestFile(filePath: string): boolean {
  const norm = normalizePath(filePath);
  return TEST_FILE_PATTERNS.some((re) => re.test(norm));
}
