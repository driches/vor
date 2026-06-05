/**
 * Deterministic "blast radius" pre-pass.
 *
 * Before the LLM agent runs, this computes — at zero token cost — the set of
 * external callers/referencers of each symbol the PR changes, so the agent can
 * proactively review cross-file impact (breaking changes, missed call sites)
 * instead of only seeing the diff and whatever it thinks to grep for.
 *
 * It is intentionally lightweight: no symbol index, no embeddings, no new
 * deps. It extracts likely public symbol names from the PR's ADDED lines with
 * a small set of language-scoped regexes (conservative — false negatives just
 * mean less context, never a wrong finding), then reuses the same `git grep`
 * machinery the `grep_repo_at_ref` tool uses to find references elsewhere in
 * the checkout.
 *
 * Caps keep it bounded: at most `maxSymbols` symbols are looked up, and each
 * lookup reports at most `maxRefsPerSymbol` distinct referencing files.
 */

import type { ChangedFile } from '../types.js';
import { runGitGrep } from '../util/git-grep.js';

export interface BlastRadiusRef {
  path: string;
  line: number;
  excerpt: string;
}

export interface BlastRadiusEntry {
  symbol: string;
  defined_in: string;
  /** Distinct referencing files (capped at maxRefsPerSymbol), one line each. */
  referenced_by: BlastRadiusRef[];
  /** Total distinct external referencing files found (may exceed referenced_by.length). */
  reference_count: number;
}

export interface BlastRadiusMap {
  entries: BlastRadiusEntry[];
  /** True if symbols and/or references were capped. */
  truncated: boolean;
}

export interface ComputeBlastRadiusInput {
  changedFiles: readonly ChangedFile[];
  workspaceDir: string;
  maxSymbols: number;
  maxRefsPerSymbol: number;
}

/** Bound the per-symbol git grep so a common name can't return thousands of
 *  lines. We over-fetch relative to maxRefsPerSymbol so reference_count (a
 *  distinct-file count) stays meaningful after same-file filtering + dedup. */
const PER_SYMBOL_GREP_CAP = 100;

/**
 * Identifier names too generic to be worth a cross-file grep — they'd match
 * everywhere and add noise, not signal. Length < MIN_SYMBOL_LENGTH is also
 * filtered (catches `id`, `fn`, `db`, single letters).
 */
const MIN_SYMBOL_LENGTH = 4;
const GENERIC_NAMES = new Set([
  'main',
  'init',
  'name',
  'type',
  'data',
  'item',
  'list',
  'value',
  'index',
  'props',
  'state',
  'config',
  'result',
  'handler',
  'callback',
]);

/**
 * Reference paths that aren't real call sites: build artifacts (the compiled
 * bundle re-contains every symbol), vendored/installed code, and prose. A hit
 * in `dist/index.js` or `CHANGELOG.md` tells the agent nothing about call-site
 * compatibility and can't be meaningfully read via `read_file_at_ref`.
 */
function isCallSitePath(path: string): boolean {
  if (/(^|\/)(dist|build|vendor|node_modules|coverage|\.git)\//.test(path)) return false;
  if (/\.(md|lock|snap|map)$/.test(path)) return false;
  return true;
}

export async function computeBlastRadius(input: ComputeBlastRadiusInput): Promise<BlastRadiusMap> {
  const symbols = collectChangedSymbols(input.changedFiles, input.maxSymbols);
  const cappedSymbols = symbols.slice(0, input.maxSymbols);
  let truncated = symbols.length > cappedSymbols.length;

  const entries: BlastRadiusEntry[] = [];
  for (const sym of cappedSymbols) {
    // Per-symbol resilience: a single failing grep (or a workspace that isn't
    // a git checkout, which fails every grep identically) degrades to "no
    // references for this symbol" rather than aborting the whole pass. The
    // net effect of a broken workspace is an empty map — the agent just loses
    // the extra context, never the review.
    let result;
    try {
      result = await runGitGrep({
        pattern: sym.name,
        cwd: input.workspaceDir,
        caseSensitive: true,
        wholeWord: true,
        // Symbols are raw identifiers, not regexes. Match them literally so a
        // legal `$` in a JS name (`$http`, `foo$`) isn't treated as an ERE
        // anchor — which would silently drop that symbol's call sites.
        fixedString: true,
        maxResults: PER_SYMBOL_GREP_CAP,
      });
    } catch {
      continue;
    }

    // Keep references OUTSIDE the defining file (in-file references aren't
    // "blast radius"), deduped to one line per file so the entry reports
    // breadth ("which files use this") rather than every occurrence.
    const byFile = new Map<string, BlastRadiusRef>();
    for (const m of result.matches) {
      if (m.path === sym.definedIn) continue;
      if (!isCallSitePath(m.path)) continue;
      if (byFile.has(m.path)) continue;
      byFile.set(m.path, { path: m.path, line: m.line, excerpt: m.text.trim().slice(0, 120) });
    }
    if (byFile.size === 0) continue;

    const refs = [...byFile.values()];
    const shown = refs.slice(0, input.maxRefsPerSymbol);
    if (refs.length > shown.length || result.truncated) truncated = true;
    entries.push({
      symbol: sym.name,
      defined_in: sym.definedIn,
      referenced_by: shown,
      reference_count: refs.length,
    });
  }

  return { entries, truncated };
}

interface ChangedSymbol {
  name: string;
  definedIn: string;
}

/**
 * Pull likely public symbol names out of the PR's added lines, deduped by
 * name (first defining file wins). Stops collecting once `limit` distinct
 * symbols are found so a huge PR doesn't build an unbounded candidate list
 * before the caller's slice.
 */
function collectChangedSymbols(files: readonly ChangedFile[], limit: number): ChangedSymbol[] {
  const seen = new Map<string, ChangedSymbol>();
  for (const file of files) {
    if (file.is_binary || file.is_generated || file.status === 'removed') continue;
    const extractor = extractorFor(file.language, file.path);
    if (!extractor) continue;

    for (const lineNo of file.added_lines) {
      const text = file.head_line_text.get(lineNo);
      if (!text) continue;
      for (const name of extractor(text)) {
        if (!isUsefulSymbol(name) || seen.has(name)) continue;
        seen.set(name, { name, definedIn: file.path });
        // +1 so the caller's slice still detects "there were more".
        if (seen.size > limit) return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

function isUsefulSymbol(name: string): boolean {
  if (name.length < MIN_SYMBOL_LENGTH) return false;
  if (GENERIC_NAMES.has(name.toLowerCase())) return false;
  return true;
}

type SymbolExtractor = (line: string) => string[];

function extractorFor(language: string, path: string): SymbolExtractor | undefined {
  const lang = language.toLowerCase();
  if (lang === 'typescript' || lang === 'javascript' || /\.[mc]?[jt]sx?$/.test(path)) {
    return extractTsJsSymbols;
  }
  if (lang === 'python' || path.endsWith('.py')) return extractPythonSymbols;
  if (lang === 'go' || path.endsWith('.go')) return extractGoSymbols;
  return undefined;
}

const TS_DECL_PATTERNS: RegExp[] = [
  /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+type\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/,
  /\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
];

function extractTsJsSymbols(line: string): string[] {
  const out: string[] = [];
  for (const re of TS_DECL_PATTERNS) {
    const m = line.match(re);
    if (m?.[1]) out.push(m[1]);
  }
  // Re-export / named export list: `export { foo, bar as baz }`. The LOCAL
  // name (left of `as`) is what's referenced inside this repo.
  const list = line.match(/\bexport\s*\{([^}]*)\}/);
  if (list?.[1]) {
    for (const part of list[1].split(',')) {
      const local = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (local && /^[A-Za-z_$][\w$]*$/.test(local)) out.push(local);
    }
  }
  return out;
}

function extractPythonSymbols(line: string): string[] {
  // Module-scope only: a def/class at column 0. Indented members are usually
  // not referenced by bare name across files. Skip dunder/private (`_`).
  const m =
    line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/) ?? line.match(/^class\s+([A-Za-z_]\w*)/);
  const name = m?.[1];
  if (!name || name.startsWith('_')) return [];
  return [name];
}

function extractGoSymbols(line: string): string[] {
  // Exported Go identifiers start uppercase. Functions/methods and top-level
  // type/var/const declarations.
  const fn = line.match(/^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)/);
  if (fn?.[1]) return [fn[1]];
  const decl = line.match(/^(?:type|var|const)\s+([A-Z]\w*)/);
  if (decl?.[1]) return [decl[1]];
  return [];
}
