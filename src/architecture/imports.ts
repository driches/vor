/**
 * Zero-dependency, comment-aware import extractor and workspace path resolver
 * across VOR's supported languages (TypeScript/JavaScript, Python, Go, Dart,
 * Rust, Java/Kotlin, C#).
 *
 * Line numbers are preserved exactly when stripping comments/docstrings so
 * deterministic findings anchor to the exact PR-added line.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { isTestFile, normalizePath } from './glob.js';

export type ArchLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'dart'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp';

export interface ExtractedImport {
  /** Raw module/package/path specifier as written in source. */
  specifier: string;
  /** 1-based line number where the specifier appears. */
  line: number;
  /** Trimmed source line for diagnostics/evidence. */
  snippet: string;
  language: ArchLanguage;
  kindHint: 'relative' | 'package' | 'ambiguous';
  /** Imported symbols/submodules in Python `from X import a, b` statements. */
  importedNames?: Array<{ name: string; line: number }>;
}

export interface FileImportMeta {
  /** Package declaration for Java/Kotlin or namespace declaration for C#. */
  declaredPackage?: string;
}

/**
 * Parsed `tsconfig.json` resolution settings, with `baseUrl` and `paths` targets
 * rebased into repository-root-relative POSIX paths.
 */
export interface TsConfigPaths {
  baseUrl?: string;
  paths: Record<string, string[]>;
}

export interface WorkspaceResolveContext {
  workspaceDir?: string;
  knownFiles?: ReadonlySet<string>;
  /** Additional PR-added/modified repo files to treat as present alongside `knownFiles`/`workspaceDir`. */
  extraFiles?: ReadonlySet<string>;
  /** Optional map of C# declared namespace -> repo file path or shared directory prefix. */
  csharpNamespaces?: ReadonlyMap<string, string>;
  /** Optional map of Kotlin FQN symbol -> repo-relative declaring `.kt`/`.kts` file path. */
  kotlinSymbols?: ReadonlyMap<string, string>;
  tsconfig?: TsConfigPaths;
  goModule?: string;
  dartPackage?: string;
}

export interface ResolvedImport {
  specifier: string;
  line: number;
  snippet: string;
  language: ArchLanguage;
  /** Repo-relative path when resolved to an internal file/module/directory; undefined for external packages. */
  resolvedPath?: string;
  /** Normalized external package/module identifier when external; undefined for internal imports. */
  packageName?: string;
}

const EXT_TO_LANG: Record<string, ArchLanguage> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  dart: 'dart',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
};

export function detectArchLanguage(filePath: string): ArchLanguage | null {
  const norm = normalizePath(filePath);
  const name = norm.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

export interface StringSpan {
  start: number;
  end: number;
}

export interface CLikeScanOptions {
  /** Treat JS/TS `` `...${...}...` `` interpolations as code rather than string content. */
  templateInterpolation?: boolean;
  /** Skip `/` regex literals in JS/TS so embedded `import`/`require` text is ignored. */
  regexLiterals?: boolean;
  /** Skip JSX element text (while still scanning `{expr}` blocks) in `.jsx`/`.tsx` files. */
  jsx?: boolean;
  /** Treat `` `...` `` as raw strings without backslash escapes (Go). */
  rawBackticks?: boolean;
  /** Recognize `"""..."""` (and `'''...'''`) multi-line strings (Dart, Java, Kotlin, C#). */
  tripleQuotes?: boolean;
  /** Distinguish Rust `'a` lifetimes from `'x'` / `'\n'` char literals. */
  rustLifetimes?: boolean;
  /** Recognize Rust raw strings `r"..."` / `r#"..."#`. */
  rustRawStrings?: boolean;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function findRustCharLiteralEnd(chars: readonly string[], openQuote: number): number {
  const n = chars.length;
  const next = chars[openQuote + 1];
  if (next === undefined || next === '\n' || next === '\r' || next === "'") return -1;
  if (next !== '\\') {
    return chars[openQuote + 2] === "'" ? openQuote + 2 : -1;
  }
  let j = openQuote + 1;
  const limit = Math.min(n, openQuote + 15);
  while (j < limit) {
    const ch = chars[j]!;
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === "'") return j;
    if (/\s/.test(ch)) return -1;
    j += 1;
  }
  return -1;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'yield',
  'await',
  'in',
  'instanceof',
  'of',
  'new',
  'else',
  'do',
  'export',
  'default',
]);

const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function findJsRegexLiteralEnd(chars: readonly string[], start: number): number {
  const n = chars.length;
  let inCharClass = false;
  let j = start + 1;
  while (j < n) {
    const ch = chars[j]!;
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      if (j + 1 >= n || chars[j + 1] === '\n' || chars[j + 1] === '\r') return -1;
      j += 2;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      j += 1;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      j += 1;
      continue;
    }
    if (ch === '/' && !inCharClass) {
      return j;
    }
    j += 1;
  }
  return -1;
}

type CodeFrame =
  | {
      kind: 'template';
      braceDepth: number;
      baseJsxDepth: number;
      resumeJsxMode: 'none' | 'open_tag';
    }
  | {
      kind: 'jsx_child_expr' | 'jsx_attr_expr';
      braceDepth: number;
      baseJsxDepth: number;
    };

function isJsxOpeningStart(chars: readonly string[], start: number): boolean {
  const n = chars.length;
  if (chars[start + 1] === '>') return true; // JSX fragment <>
  const first = chars[start + 1];
  if (first === undefined || !/[A-Za-z_$]/.test(first)) return false;

  let j = start + 2;
  while (j < n && /[A-Za-z0-9_$.:-]/.test(chars[j]!)) j += 1;
  const tagName = chars.slice(start + 1, j).join('');

  // Optional TypeScript type arguments on a JSX component: `<List<Item> ...>`
  if (chars[j] === '<') {
    let angle = 1;
    j += 1;
    while (j < n && angle > 0) {
      const c = chars[j]!;
      if (c === '\n' || c === '\r' || c === ';') return false;
      if (c === '<') angle += 1;
      else if (c === '>') angle -= 1;
      j += 1;
    }
    if (angle !== 0) return false;
  }

  const next = chars[j];
  if (next === '>' || (next === '/' && chars[j + 1] === '>')) return true;
  if (next === undefined || !/[ \t\n\r]/.test(next)) return false;

  let k = j + 1;
  while (k < n && /[ \t\n\r]/.test(chars[k]!)) k += 1;
  const ch = chars[k];
  if (ch === '>' || (ch === '/' && chars[k + 1] === '>') || ch === '{') return true;
  // Distinguish TS generic lambdas (`<T,>`, `<const T,>`, `<T = U>`, `<T extends U>`) from JSX tags.
  if (tagName === 'const' || ch === ',' || ch === '=') return false;
  if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
    let wordEnd = k + 1;
    while (wordEnd < n && isIdentChar(chars[wordEnd])) wordEnd += 1;
    const nextWord = chars.slice(k, wordEnd).join('');
    if (nextWord === 'extends') return false;
    return true;
  }
  return false;
}

type ActiveString =
  | { kind: 'quote'; quote: "'" | '"' | '`'; spanStart: number }
  | { kind: 'raw_backtick'; spanStart: number }
  | { kind: 'triple'; quote: '"' | "'"; spanStart: number }
  | { kind: 'rust_raw'; hashes: number; spanStart: number };

/**
 * Strip `//` line comments and `/* ... *\/` block comments (preserving `\n` so
 * line numbers never shift) and record sorted `[start, end]` spans of string
 * literals so regex-based import extraction skips example/template strings.
 */
export function scanCLikeSource(
  src: string,
  opts: CLikeScanOptions = {},
): { cleaned: string; stringSpans: StringSpan[] } {
  const chars = src.split('');
  const n = chars.length;
  const stringSpans: StringSpan[] = [];
  const codeFrames: CodeFrame[] = [];
  let jsxMode: 'none' | 'open_tag' | 'children' = 'none';
  let jsxDepth = 0;
  let jsxTextStart = -1;
  const currentBaseJsxDepth = (): number =>
    codeFrames.length > 0 ? codeFrames[codeFrames.length - 1]!.baseJsxDepth : 0;

  let active: ActiveString | null = null;
  let lastToken: 'expr_start' | 'expr_end' | 'control_kw' | 'dot' | 'close_brace' = 'expr_start';
  const parenStack: boolean[] = [];
  let i = 0;

  while (i < n) {
    const ch = chars[i]!;

    if (active !== null) {
      if (active.kind === 'raw_backtick') {
        if (ch === '`') {
          stringSpans.push({ start: active.spanStart, end: i });
          active = null;
          lastToken = 'expr_end';
        }
        i += 1;
        continue;
      }

      if (active.kind === 'rust_raw') {
        if (ch === '"') {
          let matchedHashes = 0;
          while (matchedHashes < active.hashes && chars[i + 1 + matchedHashes] === '#') {
            matchedHashes += 1;
          }
          if (matchedHashes === active.hashes) {
            const end = i + active.hashes;
            stringSpans.push({ start: active.spanStart, end });
            active = null;
            lastToken = 'expr_end';
            i = end + 1;
            continue;
          }
        }
        i += 1;
        continue;
      }

      if (active.kind === 'triple') {
        if (ch === '\\') {
          i += chars[i + 1] === '\r' && chars[i + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (ch === active.quote && chars[i + 1] === active.quote && chars[i + 2] === active.quote) {
          const end = i + 2;
          stringSpans.push({ start: active.spanStart, end });
          active = null;
          lastToken = 'expr_end';
          i = end + 1;
          continue;
        }
        i += 1;
        continue;
      }

      // active.kind === 'quote'
      if (ch === '\\') {
        i += chars[i + 1] === '\r' && chars[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (
        opts.templateInterpolation &&
        active.quote === '`' &&
        ch === '$' &&
        chars[i + 1] === '{'
      ) {
        stringSpans.push({ start: active.spanStart, end: i + 1 });
        codeFrames.push({
          kind: 'template',
          braceDepth: 0,
          baseJsxDepth: jsxDepth,
          resumeJsxMode: jsxMode === 'open_tag' ? 'open_tag' : 'none',
        });
        jsxMode = 'none';
        active = null;
        lastToken = 'expr_start';
        i += 2;
        continue;
      }
      if (ch === active.quote) {
        stringSpans.push({ start: active.spanStart, end: i });
        active = null;
        lastToken = 'expr_end';
        i += 1;
        continue;
      }
      // Single- and double-quoted strings do not span raw newlines; closing on
      // newline prevents an odd quote (e.g. inside a JS regex literal) from
      // swallowing the rest of the file.
      if (active.quote !== '`' && ch === '\n') {
        stringSpans.push({ start: active.spanStart, end: i });
        active = null;
        lastToken = 'expr_end';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // JSX children text runs before quotes/comments so apostrophes or slashes
    // in rendered prose never open strings or comments.
    if (jsxMode === 'children') {
      if (ch === '{') {
        if (jsxTextStart >= 0 && i > jsxTextStart + 1) {
          stringSpans.push({ start: jsxTextStart, end: i });
        }
        codeFrames.push({ kind: 'jsx_child_expr', braceDepth: 0, baseJsxDepth: jsxDepth });
        jsxMode = 'none';
        jsxTextStart = -1;
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === '<' && chars[i + 1] === '/') {
        if (jsxTextStart >= 0 && i > jsxTextStart + 1) {
          stringSpans.push({ start: jsxTextStart, end: i });
        }
        const closeGt = chars.indexOf('>', i + 2);
        if (closeGt === -1) {
          jsxTextStart = -1;
          jsxMode = 'none';
          break;
        }
        jsxDepth = Math.max(0, jsxDepth - 1);
        if (jsxDepth > currentBaseJsxDepth()) {
          jsxMode = 'children';
          jsxTextStart = closeGt;
        } else {
          jsxMode = 'none';
          jsxTextStart = -1;
          lastToken = 'expr_end';
        }
        i = closeGt + 1;
        continue;
      }
      if (ch === '<' && isJsxOpeningStart(chars, i)) {
        if (jsxTextStart >= 0 && i > jsxTextStart + 1) {
          stringSpans.push({ start: jsxTextStart, end: i });
        }
        if (chars[i + 1] === '>') {
          jsxDepth += 1;
          jsxTextStart = i + 1;
          i += 2;
          continue;
        }
        jsxDepth += 1;
        jsxMode = 'open_tag';
        jsxTextStart = -1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // Outside strings and JSX children: handle comments first.
    if (ch === '/' && chars[i + 1] === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < n && chars[i] !== '\n') {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < n) {
        if (chars[i] === '*' && chars[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          break;
        }
        if (chars[i] === '\n') {
          if (lastToken === 'close_brace') lastToken = 'expr_start';
        } else {
          chars[i] = ' ';
        }
        i += 1;
      }
      continue;
    }

    // Rust raw strings: `r"..."`, `r#"..."#`, `br#"..."#`, `cr#"..."#`.
    if (
      opts.rustRawStrings &&
      ch === 'r' &&
      (!isIdentChar(chars[i - 1]) ||
        ((chars[i - 1] === 'b' || chars[i - 1] === 'c') && !isIdentChar(chars[i - 2])))
    ) {
      let hashes = 0;
      while (chars[i + 1 + hashes] === '#') hashes += 1;
      if (chars[i + 1 + hashes] === '"') {
        const quotePos = i + 1 + hashes;
        active = { kind: 'rust_raw', hashes, spanStart: quotePos };
        i = quotePos + 1;
        continue;
      }
    }

    if (
      opts.tripleQuotes &&
      (ch === '"' || ch === "'") &&
      chars[i + 1] === ch &&
      chars[i + 2] === ch
    ) {
      active = { kind: 'triple', quote: ch, spanStart: i };
      i += 3;
      continue;
    }

    if (ch === "'" && opts.rustLifetimes) {
      const charEnd = findRustCharLiteralEnd(chars, i);
      if (charEnd !== -1) {
        stringSpans.push({ start: i, end: charEnd });
        i = charEnd + 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '`') {
      active = opts.rawBackticks
        ? { kind: 'raw_backtick', spanStart: i }
        : { kind: 'quote', quote: '`', spanStart: i };
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      active = { kind: 'quote', quote: ch, spanStart: i };
      i += 1;
      continue;
    }

    if (jsxMode === 'open_tag') {
      if (ch === '{') {
        codeFrames.push({ kind: 'jsx_attr_expr', braceDepth: 0, baseJsxDepth: jsxDepth });
        jsxMode = 'none';
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === '/' && chars[i + 1] === '>') {
        jsxDepth = Math.max(0, jsxDepth - 1);
        if (jsxDepth > currentBaseJsxDepth()) {
          jsxMode = 'children';
          jsxTextStart = i + 1;
        } else {
          jsxMode = 'none';
          jsxTextStart = -1;
          lastToken = 'expr_end';
        }
        i += 2;
        continue;
      }
      if (ch === '>') {
        jsxMode = 'children';
        jsxTextStart = i;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // Track JS/TS `${ ... }` and JSX `{ ... }` interpolation braces.
    if ((opts.templateInterpolation || opts.jsx) && codeFrames.length > 0) {
      if (ch === '{') {
        codeFrames[codeFrames.length - 1]!.braceDepth += 1;
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === '}') {
        const top = codeFrames[codeFrames.length - 1]!;
        if (top.braceDepth === 0) {
          codeFrames.pop();
          if (top.kind === 'template') {
            jsxMode = top.resumeJsxMode;
            active = { kind: 'quote', quote: '`', spanStart: i };
          } else if (top.kind === 'jsx_child_expr') {
            jsxMode = 'children';
            jsxTextStart = i;
          } else {
            jsxMode = 'open_tag';
          }
        } else {
          top.braceDepth -= 1;
          lastToken = 'close_brace';
        }
        i += 1;
        continue;
      }
    }

    if (opts.jsx && ch === '<' && lastToken === 'expr_start' && isJsxOpeningStart(chars, i)) {
      if (chars[i + 1] === '>') {
        jsxDepth += 1;
        jsxMode = 'children';
        jsxTextStart = i + 1;
        i += 2;
        continue;
      }
      jsxDepth += 1;
      jsxMode = 'open_tag';
      i += 1;
      continue;
    }

    if (opts.regexLiterals) {
      if (ch === '\n') {
        if (lastToken === 'close_brace') lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
        i += 1;
        continue;
      }
      if (ch === '<' && chars[i + 1] === '/') {
        lastToken = 'expr_end';
        i += 2;
        continue;
      }
      if (ch === '/') {
        if (lastToken === 'expr_start') {
          const regexEnd = findJsRegexLiteralEnd(chars, i);
          if (regexEnd !== -1) {
            stringSpans.push({ start: i, end: regexEnd });
            i = regexEnd + 1;
            while (i < n && /[A-Za-z]/.test(chars[i]!)) i += 1;
            lastToken = 'expr_end';
            continue;
          }
        }
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if ((ch === '+' || ch === '-') && chars[i + 1] === ch) {
        lastToken = 'expr_end';
        i += 2;
        continue;
      }
      if (ch === '(') {
        parenStack.push(lastToken === 'control_kw');
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === ')') {
        lastToken = (parenStack.pop() ?? false) ? 'expr_start' : 'expr_end';
        i += 1;
        continue;
      }
      if (ch === ']') {
        lastToken = 'expr_end';
        i += 1;
        continue;
      }
      if (ch === '{') {
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
      if (ch === '}') {
        lastToken = 'close_brace';
        i += 1;
        continue;
      }
      if (ch === '.') {
        lastToken = 'dot';
        i += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let wordEnd = i + 1;
        while (wordEnd < n && isIdentChar(chars[wordEnd])) wordEnd += 1;
        const word = chars.slice(i, wordEnd).join('');
        if (lastToken === 'dot') {
          lastToken = 'expr_end';
        } else if (CONTROL_PAREN_KEYWORDS.has(word)) {
          lastToken = 'control_kw';
        } else if (REGEX_PREFIX_KEYWORDS.has(word)) {
          lastToken = 'expr_start';
        } else {
          lastToken = 'expr_end';
        }
        i = wordEnd;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        lastToken = 'expr_end';
        i += 1;
        continue;
      }
      if (',;:?=!&|^~+-*%<>['.includes(ch)) {
        lastToken = 'expr_start';
        i += 1;
        continue;
      }
    }

    i += 1;
  }

  return { cleaned: chars.join(''), stringSpans };
}

/** Binary search checking whether `offset` falls strictly inside a string literal. */
function isInsideStringSpan(offset: number, spans: readonly StringSpan[]): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    if (offset <= span.start) {
      hi = mid - 1;
    } else if (offset >= span.end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments while preserving
 * string literals and replacing comment characters with spaces (keeping `\n`
 * intact so 1-based line numbers never shift).
 */
export function stripCLikeComments(src: string): string {
  return scanCLikeSource(src).cleaned;
}

/**
 * Strip Python `#` comments and triple-quoted string literals/docstrings while
 * preserving exact line numbers and single-line quoted strings.
 */
export function stripPythonCommentsAndDocstrings(src: string): string {
  const chars = src.split('');
  const n = chars.length;
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < n) {
    const ch = chars[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote || ch === '\n') {
        quote = null;
      }
      i += 1;
      continue;
    }

    if ((ch === '"' || ch === "'") && chars[i + 1] === ch && chars[i + 2] === ch) {
      const delim = ch;
      chars[i] = ' ';
      chars[i + 1] = ' ';
      chars[i + 2] = ' ';
      i += 3;
      while (i < n) {
        if (chars[i] === '\\') {
          if (chars[i] !== '\n') chars[i] = ' ';
          if (i + 1 < n && chars[i + 1] !== '\n') chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (chars[i] === delim && chars[i + 1] === delim && chars[i + 2] === delim) {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          chars[i + 2] = ' ';
          i += 3;
          break;
        }
        if (chars[i] !== '\n') chars[i] = ' ';
        i += 1;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < n && chars[i] !== '\n') {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return chars.join('');
}

function buildLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAtOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

function makeSnippet(lines: readonly string[], line: number): string {
  const raw = lines[line - 1] ?? '';
  const trimmed = raw.trim();
  return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
}

function dedupExtracted(items: ExtractedImport[]): ExtractedImport[] {
  const seen = new Set<string>();
  const out: ExtractedImport[] = [];
  for (const item of items) {
    const key = `${item.line}:${item.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractJsTsImports(
  content: string,
  language: 'typescript' | 'javascript',
  jsx = false,
): ExtractedImport[] {
  const { cleaned, stringSpans } = scanCLikeSource(content, {
    templateInterpolation: true,
    regexLiterals: true,
    jsx,
  });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const pushMatch = (spec: string, offset: number): void => {
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: spec,
      line,
      snippet: makeSnippet(rawLines, line),
      language,
      kindHint: spec.startsWith('./') || spec.startsWith('../') ? 'relative' : 'ambiguous',
    });
  };

  // Static ES import/export ... from 'spec'
  const esFrom =
    /\b(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?)\s+from\s*(['"])([^'"]+)\1/g;
  for (const m of cleaned.matchAll(esFrom)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[2]!;
    const specOffset = idx + m[0].lastIndexOf(spec);
    pushMatch(spec, specOffset);
  }

  // Side-effect import 'spec'
  const sideEffect = /\bimport\s+(['"])([^'"]+)\1/g;
  for (const m of cleaned.matchAll(sideEffect)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[2]!;
    const specOffset = idx + m[0].lastIndexOf(spec);
    pushMatch(spec, specOffset);
  }

  // CommonJS require('spec')
  const req = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of cleaned.matchAll(req)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[2]!;
    const specOffset = idx + m[0].lastIndexOf(spec);
    pushMatch(spec, specOffset);
  }

  // Dynamic import('spec')
  const dyn = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*(?:,|\))/g;
  for (const m of cleaned.matchAll(dyn)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[2]!;
    const specOffset = idx + m[0].lastIndexOf(spec);
    pushMatch(spec, specOffset);
  }

  return dedupExtracted(out);
}

function parsePythonImportNames(
  cleaned: string,
  clauseStart: number,
  clauseEnd: number,
  starts: readonly number[],
): Array<{ name: string; line: number }> {
  const names: Array<{ name: string; line: number }> = [];
  let segStart = clauseStart;
  const pushSegment = (rawStart: number, rawEnd: number): void => {
    const raw = cleaned.slice(rawStart, rawEnd).replace(/\\\r?\n/g, ' ');
    const leadWs = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '*') return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?$/.exec(trimmed);
    if (!m?.[1]) return;
    const identOffset = rawStart + leadWs;
    names.push({ name: m[1], line: lineAtOffset(starts, identOffset) });
  };

  for (let i = clauseStart; i < clauseEnd; i++) {
    if (cleaned[i] === ',') {
      pushSegment(segStart, i);
      segStart = i + 1;
    }
  }
  pushSegment(segStart, clauseEnd);
  return names;
}

function findPythonImportClauseBounds(
  cleaned: string,
  afterImportOffset: number,
): { start: number; end: number } {
  const n = cleaned.length;
  let pos = afterImportOffset;
  while (pos < n && (cleaned[pos] === ' ' || cleaned[pos] === '\t')) pos += 1;

  if (cleaned[pos] === '(') {
    const close = cleaned.indexOf(')', pos + 1);
    return { start: pos + 1, end: close === -1 ? n : close };
  }

  let end = pos;
  while (end < n) {
    const ch = cleaned[end]!;
    if (ch === ';' || ch === '\n') break;
    if (ch === '\\') {
      if (cleaned[end + 1] === '\n') {
        end += 2;
        continue;
      }
      if (cleaned[end + 1] === '\r' && cleaned[end + 2] === '\n') {
        end += 3;
        continue;
      }
    }
    end += 1;
  }
  return { start: pos, end };
}

function extractPythonImports(content: string): ExtractedImport[] {
  const cleaned = stripPythonCommentsAndDocstrings(content);
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const fromRe = /^[ \t]*from[ \t]+(\.{1,}[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)[ \t]+import\b/gm;
  for (const m of cleaned.matchAll(fromRe)) {
    const spec = m[1]!;
    const offset = (m.index ?? 0) + m[0].indexOf(spec);
    const baseLine = lineAtOffset(starts, offset);
    const clause = findPythonImportClauseBounds(cleaned, (m.index ?? 0) + m[0].length);
    const importedNames = parsePythonImportNames(cleaned, clause.start, clause.end, starts);

    // Pure relative dots (`from .. import adapters, ports`) directly name sibling
    // modules/packages; expand each imported item into a relative specifier.
    if (/^\.+$/.test(spec) && importedNames.length > 0) {
      for (const item of importedNames) {
        const subSpec = `${spec}${item.name}`;
        out.push({
          specifier: subSpec,
          line: item.line,
          snippet: makeSnippet(rawLines, item.line),
          language: 'python',
          kindHint: 'relative',
        });
      }
      continue;
    }

    out.push({
      specifier: spec,
      line: baseLine,
      snippet: makeSnippet(rawLines, baseLine),
      language: 'python',
      kindHint: spec.startsWith('.') ? 'relative' : 'ambiguous',
      ...(importedNames.length > 0 ? { importedNames } : {}),
    });
  }

  const importRe = /^[ \t]*import\s+([^\n;#]+)/gm;
  for (const m of cleaned.matchAll(importRe)) {
    const listText = m[1]!;
    const baseOffset = (m.index ?? 0) + m[0].indexOf(listText);
    const line = lineAtOffset(starts, baseOffset);
    for (const part of listText.split(',')) {
      const mod = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!mod || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(mod)) continue;
      out.push({
        specifier: mod,
        line,
        snippet: makeSnippet(rawLines, line),
        language: 'python',
        kindHint: 'ambiguous',
      });
    }
  }

  return dedupExtracted(out);
}

function extractGoImports(content: string): ExtractedImport[] {
  const { cleaned, stringSpans } = scanCLikeSource(content, { rawBackticks: true });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const addSpec = (spec: string, offset: number): void => {
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: spec,
      line,
      snippet: makeSnippet(rawLines, line),
      language: 'go',
      kindHint: spec.startsWith('./') || spec.startsWith('../') ? 'relative' : 'ambiguous',
    });
  };

  const blockRe = /\bimport\s*\(([^)]*)\)/g;
  for (const m of cleaned.matchAll(blockRe)) {
    const mIdx = m.index ?? 0;
    if (isInsideStringSpan(mIdx, stringSpans)) continue;
    const block = m[1]!;
    const blockStart = mIdx + m[0].indexOf(block);
    const itemRe = /^[ \t]*(?:[A-Za-z_]\w*|\.)?[ \t]*(?:"([^"]+)"|`([^`]+)`)/gm;
    for (const im of block.matchAll(itemRe)) {
      const spec = (im[1] ?? im[2])!;
      const offset = blockStart + (im.index ?? 0) + im[0].indexOf(spec);
      addSpec(spec, offset);
    }
  }

  const singleRe = /^[ \t]*import[ \t]+(?:(?:[A-Za-z_]\w*|\.)[ \t]+)?(?:"([^"]+)"|`([^`]+)`)/gm;
  for (const m of cleaned.matchAll(singleRe)) {
    const mIdx = m.index ?? 0;
    if (isInsideStringSpan(mIdx, stringSpans)) continue;
    const spec = (m[1] ?? m[2])!;
    const offset = mIdx + m[0].indexOf(spec);
    addSpec(spec, offset);
  }

  return dedupExtracted(out);
}

function extractDartImports(content: string): ExtractedImport[] {
  const { cleaned, stringSpans } = scanCLikeSource(content, { tripleQuotes: true });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const re = /^[ \t]*(?:import|export|part)\s+(['"])([^'"]+)\1/gm;
  for (const m of cleaned.matchAll(re)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[2]!;
    const offset = idx + m[0].lastIndexOf(spec);
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: spec,
      line,
      snippet: makeSnippet(rawLines, line),
      language: 'dart',
      kindHint: spec.startsWith('dart:')
        ? 'package'
        : spec.startsWith('package:')
          ? 'ambiguous'
          : 'relative',
    });
  }

  return dedupExtracted(out);
}

interface RustLeaf {
  path: string;
  offset: number;
}

function splitTopLevelCommas(text: string): Array<{ part: string; offset: number }> {
  const parts: Array<{ part: string; offset: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push({ part: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ part: text.slice(start), offset: start });
  return parts;
}

function expandRustUseTree(tree: string, baseOffset: number, prefix = ''): RustLeaf[] {
  const trimmed = tree.trim();
  if (!trimmed) return [];
  const leadingSpaces = tree.length - tree.trimStart().length;
  const trimmedOffset = baseOffset + leadingSpaces;

  const braceStart = trimmed.indexOf('{');
  if (braceStart === -1) {
    let clean = trimmed.replace(/\s+as\s+[A-Za-z_]\w*$/, '').trim();
    if (clean === 'self') {
      return prefix ? [{ path: prefix, offset: trimmedOffset }] : [];
    }
    if (clean === '*') {
      return prefix ? [{ path: prefix, offset: trimmedOffset }] : [];
    }
    clean = clean.replace(/::\*$/, '');
    const full = prefix ? `${prefix}::${clean}` : clean;
    return full ? [{ path: full, offset: trimmedOffset }] : [];
  }

  const braceEnd = trimmed.lastIndexOf('}');
  if (braceEnd <= braceStart) return [];

  const headRaw = trimmed.slice(0, braceStart).trim().replace(/::$/, '');
  const nextPrefix = headRaw ? (prefix ? `${prefix}::${headRaw}` : headRaw) : prefix;
  const inner = trimmed.slice(braceStart + 1, braceEnd);
  const innerOffset = trimmedOffset + braceStart + 1;

  const leaves: RustLeaf[] = [];
  for (const chunk of splitTopLevelCommas(inner)) {
    leaves.push(...expandRustUseTree(chunk.part, innerOffset + chunk.offset, nextPrefix));
  }
  return leaves;
}

function extractRustImports(content: string): ExtractedImport[] {
  const { cleaned, stringSpans } = scanCLikeSource(content, {
    rustLifetimes: true,
    rustRawStrings: true,
  });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const classifyRustSpec = (spec: string): ExtractedImport['kindHint'] => {
    if (spec.startsWith('crate::') || spec.startsWith('super::') || spec.startsWith('self::')) {
      return 'relative';
    }
    return 'package';
  };

  const useRe = /\b(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/g;
  for (const m of cleaned.matchAll(useRe)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const expr = m[1]!;
    const exprOffset = idx + m[0].indexOf(expr);
    for (const leaf of expandRustUseTree(expr, exprOffset)) {
      const line = lineAtOffset(starts, leaf.offset);
      out.push({
        specifier: leaf.path,
        line,
        snippet: makeSnippet(rawLines, line),
        language: 'rust',
        kindHint: classifyRustSpec(leaf.path),
      });
    }
  }

  const externRe = /\bextern\s+crate\s+([A-Za-z_]\w*)(?:\s+as\s+[A-Za-z_]\w*)?\s*;/g;
  for (const m of cleaned.matchAll(externRe)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const name = m[1]!;
    const offset = idx + m[0].indexOf(name);
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: name,
      line,
      snippet: makeSnippet(rawLines, line),
      language: 'rust',
      kindHint: 'package',
    });
  }

  const modRe = /\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/g;
  for (const m of cleaned.matchAll(modRe)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const name = m[1]!;
    const offset = idx + m[0].indexOf(name);
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: `mod:${name}`,
      line,
      snippet: makeSnippet(rawLines, line),
      language: 'rust',
      kindHint: 'relative',
    });
  }

  return dedupExtracted(out);
}

interface JvmTreeIndex {
  byBaseName: Map<string, string[]>;
  byLastDirSeg: Map<string, string[]>;
}

const jvmTreeIndexCache = new WeakMap<ReadonlySet<string>, JvmTreeIndex>();

function getJvmTreeIndex(files: ReadonlySet<string>): JvmTreeIndex {
  const cached = jvmTreeIndexCache.get(files);
  if (cached) return cached;

  const prod: string[] = [];
  const test: string[] = [];
  for (const raw of files) {
    const norm = normalizePath(raw);
    if (!norm || !/\.(?:java|kt|kts)$/i.test(norm)) continue;
    if (isTestFile(norm)) test.push(norm);
    else prod.push(norm);
  }
  prod.sort();
  test.sort();

  const byBaseName = new Map<string, string[]>();
  const byLastDirSeg = new Map<string, string[]>();
  const seenDirs = new Set<string>();

  for (const f of [...prod, ...test]) {
    const base = posix.basename(f);
    let baseList = byBaseName.get(base);
    if (!baseList) {
      baseList = [];
      byBaseName.set(base, baseList);
    }
    baseList.push(f);

    let dir = posix.dirname(f);
    while (dir && dir !== '.' && !seenDirs.has(dir)) {
      seenDirs.add(dir);
      const lastSeg = posix.basename(dir);
      let dirList = byLastDirSeg.get(lastSeg);
      if (!dirList) {
        dirList = [];
        byLastDirSeg.set(lastSeg, dirList);
      }
      dirList.push(dir);
      const parent = posix.dirname(dir);
      dir = parent === dir ? '' : parent;
    }
  }

  const index: JvmTreeIndex = { byBaseName, byLastDirSeg };
  jvmTreeIndexCache.set(files, index);
  return index;
}

function findJvmFileAcrossRoots(
  specPath: string,
  exts: readonly string[],
  ctx: WorkspaceResolveContext,
): string | undefined {
  const sets = [ctx.extraFiles, ctx.knownFiles].filter(
    (s): s is ReadonlySet<string> => s !== undefined,
  );
  if (sets.length === 0) return undefined;

  for (const set of sets) {
    const idx = getJvmTreeIndex(set);
    for (const ext of exts) {
      const rel = `${specPath}.${ext}`;
      const base = posix.basename(rel);
      const candidates = idx.byBaseName.get(base);
      if (!candidates) continue;
      for (const f of candidates) {
        if (f === rel) return f;
      }
      const suffix = `/${rel}`;
      for (const f of candidates) {
        if (f.endsWith(suffix)) return f;
      }
    }
  }
  return undefined;
}

/**
 * Find repository directory paths whose suffix matches `pkgPath` (e.g.
 * `com/acme/orders` -> `modules/orders/src/main/java/com/acme/orders`).
 */
export function findJvmPackageDirsInTree(pkgPath: string, ctx: WorkspaceResolveContext): string[] {
  const normPkg = normalizePath(pkgPath);
  if (!normPkg) return [];
  const lastSeg = posix.basename(normPkg);
  const suffix = `/${normPkg}`;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of [ctx.extraFiles, ctx.knownFiles]) {
    if (!set) continue;
    const dirs = getJvmTreeIndex(set).byLastDirSeg.get(lastSeg);
    if (!dirs) continue;
    for (const d of dirs) {
      if ((d === normPkg || d.endsWith(suffix)) && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out;
}

function findJvmPackage(cleaned: string, stringSpans: readonly StringSpan[]): string | undefined {
  for (const m of cleaned.matchAll(/^[ \t]*package\s+([A-Za-z_][\w.]*)\s*;?/gm)) {
    if (!isInsideStringSpan(m.index ?? 0, stringSpans)) {
      return m[1];
    }
  }
  return undefined;
}

/**
 * Derive the JVM source root prefix (e.g. `src/main/kotlin`) for a file path
 * declaring `declaredPackage`, or `''` if the package starts at repo root.
 */
export function findJvmSourceRoot(normSource: string, declaredPackage: string | undefined): string {
  if (!declaredPackage) return '';
  const pkgPath = declaredPackage.replace(/\./g, '/');
  const dir = posix.dirname(normSource);
  if (dir === pkgPath) return '';
  if (dir.endsWith(`/${pkgPath}`)) {
    return dir.slice(0, dir.length - pkgPath.length - 1);
  }
  return '';
}

function buildKotlinTopLevelSurface(cleaned: string, stringSpans: readonly StringSpan[]): string {
  const n = cleaned.length;
  const out: string[] = new Array<string>(n);
  let braceDepth = 0;
  let parenDepth = 0;

  for (let i = 0; i < n; i++) {
    const ch = cleaned[i]!;
    if (ch === '\n') {
      out[i] = '\n';
      continue;
    }
    if (isInsideStringSpan(i, stringSpans)) {
      out[i] = ' ';
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      out[i] = ' ';
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      out[i] = ' ';
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      out[i] = ' ';
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      out[i] = ' ';
      continue;
    }
    out[i] = braceDepth > 0 || parenDepth > 0 ? ' ' : ch;
  }

  return out.join('').replace(/^[ \t]*(?:package|import)\b[^\n]*/gm, '');
}

/**
 * Extract the declared package and top-level Kotlin symbols (classes, interfaces,
 * objects, typealiases, functions, properties) from Kotlin source text.
 */
export function extractKotlinDeclarations(content: string): {
  packageName?: string;
  symbols: string[];
} {
  const { cleaned, stringSpans } = scanCLikeSource(content, { tripleQuotes: true });
  const packageName = findJvmPackage(cleaned, stringSpans);
  const topLevel = buildKotlinTopLevelSurface(cleaned, stringSpans);
  const len = topLevel.length;
  const symbols = new Set<string>();

  const declRe = /\b(class|interface|object|typealias|fun|val|var)\b/g;
  for (const m of topLevel.matchAll(declRe)) {
    const kwIdx = m.index ?? 0;
    const prev = kwIdx > 0 ? topLevel[kwIdx - 1] : '';
    if (prev === '.' || prev === ':') continue;

    const kw = m[1]!;
    let pos = kwIdx + m[0].length;

    const skipWs = (): void => {
      while (pos < len && /\s/.test(topLevel[pos]!)) pos += 1;
    };
    const readIdent = (): string => {
      const start = pos;
      if (pos >= len || !/[A-Za-z_]/.test(topLevel[pos]!)) return '';
      pos += 1;
      while (pos < len && /\w/.test(topLevel[pos]!)) pos += 1;
      return topLevel.slice(start, pos);
    };
    const skipBalancedAngles = (): boolean => {
      if (topLevel[pos] !== '<') return false;
      let depth = 0;
      while (pos < len) {
        const ch = topLevel[pos]!;
        if (ch === '=' || ch === ';' || ch === '\n') return false;
        if (ch === '<') depth += 1;
        else if (ch === '>') {
          depth -= 1;
          if (depth === 0) {
            pos += 1;
            return true;
          }
        }
        pos += 1;
      }
      return false;
    };

    skipWs();

    if (kw === 'class' || kw === 'interface' || kw === 'object' || kw === 'typealias') {
      const ident = readIdent();
      if (ident) symbols.add(ident);
      continue;
    }

    // `fun interface Foo` is matched again on `interface`; skip `fun`.
    if (kw === 'fun' && topLevel.slice(pos, pos + 9) === 'interface') {
      const after = topLevel[pos + 9];
      if (after === undefined || !/\w/.test(after)) continue;
    }

    if (pos < len && topLevel[pos] === '<') {
      if (!skipBalancedAngles()) continue;
      skipWs();
    }

    const first = readIdent();
    if (!first) continue;
    let recorded = first;
    while (pos < len) {
      skipWs();
      if (pos < len && topLevel[pos] === '<') {
        if (!skipBalancedAngles()) {
          recorded = '';
          break;
        }
        skipWs();
      }
      if (pos < len && topLevel[pos] === '?') {
        pos += 1;
        skipWs();
      }
      if (pos < len && topLevel[pos] === '.') {
        pos += 1;
        skipWs();
        const nextIdent = readIdent();
        if (!nextIdent) {
          recorded = '';
          break;
        }
        recorded = nextIdent;
        continue;
      }
      break;
    }
    if (recorded) symbols.add(recorded);
  }

  return {
    ...(packageName ? { packageName } : {}),
    symbols: [...symbols],
  };
}

function extractJavaKotlinImports(
  content: string,
  language: 'java' | 'kotlin',
): { imports: ExtractedImport[]; meta: FileImportMeta } {
  const { cleaned, stringSpans } = scanCLikeSource(content, { tripleQuotes: true });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const declaredPackage = findJvmPackage(cleaned, stringSpans);

  const importRe =
    /^[ \t]*import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+[A-Za-z_]\w*)?\s*;?/gm;
  for (const m of cleaned.matchAll(importRe)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[1]!;
    const offset = idx + m[0].indexOf(spec);
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: spec,
      line,
      snippet: makeSnippet(rawLines, line),
      language,
      kindHint: 'ambiguous',
    });
  }

  return {
    imports: dedupExtracted(out),
    meta: declaredPackage ? { declaredPackage } : {},
  };
}

const CS_NAMESPACE_RE = /^[ \t]*(?:file\s+)?namespace\s+([A-Za-z_][\w.]*)/gm;

function findCSharpNamespaceFromCleaned(
  cleaned: string,
  stringSpans: readonly StringSpan[],
): string | undefined {
  for (const m of cleaned.matchAll(CS_NAMESPACE_RE)) {
    if (!isInsideStringSpan(m.index ?? 0, stringSpans)) {
      return m[1];
    }
  }
  return undefined;
}

/**
 * Extract the primary `namespace` declaration from C# source text (ignoring
 * comments and string literals).
 */
export function extractCSharpNamespace(content: string): string | undefined {
  const { cleaned, stringSpans } = scanCLikeSource(content, { tripleQuotes: true });
  return findCSharpNamespaceFromCleaned(cleaned, stringSpans);
}

function extractCSharpImports(content: string): {
  imports: ExtractedImport[];
  meta: FileImportMeta;
} {
  const { cleaned, stringSpans } = scanCLikeSource(content, { tripleQuotes: true });
  const starts = buildLineStarts(cleaned);
  const rawLines = content.split('\n');
  const out: ExtractedImport[] = [];

  const declaredPackage = findCSharpNamespaceFromCleaned(cleaned, stringSpans);

  const usingRe =
    /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm;
  for (const m of cleaned.matchAll(usingRe)) {
    const idx = m.index ?? 0;
    if (isInsideStringSpan(idx, stringSpans)) continue;
    const spec = m[1]!;
    if (spec === 'var') continue;
    const offset = idx + m[0].indexOf(spec);
    const line = lineAtOffset(starts, offset);
    out.push({
      specifier: spec,
      line,
      snippet: makeSnippet(rawLines, line),
      language: 'csharp',
      kindHint: 'ambiguous',
    });
  }

  return {
    imports: dedupExtracted(out),
    meta: declaredPackage ? { declaredPackage } : {},
  };
}

export function extractImports(
  filePath: string,
  content: string,
): { imports: ExtractedImport[]; meta: FileImportMeta } {
  const language = detectArchLanguage(filePath);
  if (!language) return { imports: [], meta: {} };

  switch (language) {
    case 'typescript':
    case 'javascript':
      return {
        imports: extractJsTsImports(content, language, /\.(?:jsx|tsx)$/i.test(filePath)),
        meta: {},
      };
    case 'python':
      return { imports: extractPythonImports(content), meta: {} };
    case 'go':
      return { imports: extractGoImports(content), meta: {} };
    case 'dart':
      return { imports: extractDartImports(content), meta: {} };
    case 'rust':
      return { imports: extractRustImports(content), meta: {} };
    case 'java':
    case 'kotlin':
      return extractJavaKotlinImports(content, language);
    case 'csharp':
      return extractCSharpImports(content);
  }
}

/**
 * Strip `//` and `/* ... *\/` comments and trailing commas from JSONC
 * (`tsconfig.json`) while preserving string literal contents.
 */
function stripJsonc(text: string): string {
  const noComments = stripCLikeComments(text);
  // Remove trailing commas before `}` or `]` outside strings.
  const chars = noComments.split('');
  let quote: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j]!)) j += 1;
      if (chars[j] === '}' || chars[j] === ']') {
        chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}

function rebaseFromDir(baseDir: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/');
  const joined =
    baseDir && baseDir !== '.' ? posix.join(baseDir, cleaned) : posix.normalize(cleaned);
  const norm = normalizePath(joined);
  return norm === '' ? '.' : norm;
}

/** Extract relative `./` or `../` `extends` entries from a JSONC tsconfig string. */
export function extractTsConfigExtends(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return []; // malformed tsconfig shouldn't abort architecture scanning
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const ext = (parsed as { extends?: unknown }).extends;
  const entries = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
  return entries.filter(
    (item): item is string =>
      typeof item === 'string' && (item.startsWith('./') || item.startsWith('../')),
  );
}

interface RawTsConfigPaths {
  baseUrl?: string;
  rawPaths: Record<string, string[]>;
  pathsDefinedDir: string;
  hasExplicitPaths: boolean;
}

function parseTsConfigInternal(
  raw: string,
  readRelative?: (relPath: string) => string | null,
  depth = 0,
  configDir = '',
): RawTsConfigPaths | undefined {
  if (depth > 2) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return undefined; // malformed tsconfig shouldn't abort architecture scanning
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as {
    extends?: unknown;
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  };

  let baseUrl: string | undefined;
  let rawPaths: Record<string, string[]> = {};
  let pathsDefinedDir = configDir;
  let inheritedExplicitPaths = false;

  if (readRelative) {
    const extEntries =
      typeof obj.extends === 'string'
        ? [obj.extends]
        : Array.isArray(obj.extends)
          ? obj.extends
          : [];
    for (const ext of extEntries) {
      if (typeof ext !== 'string' || (!ext.startsWith('./') && !ext.startsWith('../'))) {
        continue;
      }
      const extTarget = rebaseFromDir(configDir, ext);
      if (extTarget === '..' || extTarget.startsWith('../')) continue;
      let resolvedExtPath = extTarget;
      let extRaw = readRelative(resolvedExtPath);
      if (extRaw === null && !resolvedExtPath.endsWith('.json')) {
        resolvedExtPath = `${extTarget}.json`;
        extRaw = readRelative(resolvedExtPath);
      }
      if (extRaw) {
        const rawParentDir = posix.dirname(resolvedExtPath);
        const parentDir = rawParentDir === '.' ? '' : rawParentDir;
        const parent = parseTsConfigInternal(extRaw, readRelative, depth + 1, parentDir);
        if (parent) {
          if (parent.baseUrl !== undefined) {
            baseUrl = parent.baseUrl;
          }
          if (parent.hasExplicitPaths) {
            inheritedExplicitPaths = true;
            rawPaths = { ...parent.rawPaths };
            pathsDefinedDir = parent.pathsDefinedDir;
          }
        }
      }
    }
  }

  const co = obj.compilerOptions;
  if (typeof co?.baseUrl === 'string') {
    baseUrl = rebaseFromDir(configDir, co.baseUrl);
  }
  const hasOwnPaths =
    co?.paths !== undefined && typeof co.paths === 'object' && !Array.isArray(co.paths);
  if (hasOwnPaths) {
    // Keep un-rebased substitution patterns alongside the declaring config dir;
    // rebasing waits until the root config's effective `baseUrl` is known.
    rawPaths = {};
    pathsDefinedDir = configDir;
    for (const [k, v] of Object.entries(co.paths as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        rawPaths[k] = v.filter((item): item is string => typeof item === 'string');
      }
    }
  }

  const hasExplicitPaths = hasOwnPaths || inheritedExplicitPaths;
  if (baseUrl === undefined && !hasExplicitPaths) {
    return undefined;
  }
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    rawPaths,
    pathsDefinedDir,
    hasExplicitPaths,
  };
}

export function parseTsConfigContent(
  raw: string,
  readRelative?: (relPath: string) => string | null,
  depth = 0,
  configDir = '',
): TsConfigPaths | undefined {
  const res = parseTsConfigInternal(raw, readRelative, depth, configDir);
  if (!res) return undefined;
  const pathsBase = res.baseUrl ?? res.pathsDefinedDir;
  const paths: Record<string, string[]> = {};
  for (const [k, targets] of Object.entries(res.rawPaths)) {
    paths[k] = targets.map((item) => rebaseFromDir(pathsBase, item));
  }
  if (res.baseUrl === undefined && Object.keys(paths).length === 0) {
    return undefined;
  }
  return {
    ...(res.baseUrl !== undefined ? { baseUrl: res.baseUrl } : {}),
    paths,
  };
}

export function parseGoModModule(raw: string): string | undefined {
  const m = raw.match(/^[ \t]*module[ \t]+([^\s/]+\/[^\s]+|[^\s]+)/m);
  return m?.[1]?.trim();
}

export function parsePubspecName(raw: string): string | undefined {
  const m = raw.match(/^[ \t]*name:[ \t]*['"]?([A-Za-z0-9_-]+)['"]?/m);
  return m?.[1]?.trim();
}

function readOptionalFile(workspaceDir: string, relPath: string): string | null {
  try {
    return readFileSync(resolve(workspaceDir, relPath), 'utf-8');
  } catch {
    return null; // optional workspace metadata file
  }
}

export function loadWorkspaceResolveContext(
  workspaceDir?: string,
  opts: { knownFiles?: ReadonlySet<string> } = {},
): WorkspaceResolveContext {
  const ctx: WorkspaceResolveContext = {
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(opts.knownFiles !== undefined ? { knownFiles: opts.knownFiles } : {}),
  };

  if (!workspaceDir) return ctx;

  const tsRaw = readOptionalFile(workspaceDir, 'tsconfig.json');
  if (tsRaw) {
    const tsconfig = parseTsConfigContent(tsRaw, (rel) => readOptionalFile(workspaceDir, rel));
    if (tsconfig) ctx.tsconfig = tsconfig;
  }

  const goRaw = readOptionalFile(workspaceDir, 'go.mod');
  if (goRaw) {
    const goModule = parseGoModModule(goRaw);
    if (goModule) ctx.goModule = goModule;
  }

  const pubRaw = readOptionalFile(workspaceDir, 'pubspec.yaml');
  if (pubRaw) {
    const dartPkg = parsePubspecName(pubRaw);
    if (dartPkg) ctx.dartPackage = dartPkg;
  }

  return ctx;
}

function existsRepoFile(path: string, ctx: WorkspaceResolveContext): boolean {
  const norm = normalizePath(path);
  if (!norm) return false;
  if (ctx.extraFiles?.has(norm)) return true;
  if (ctx.knownFiles) {
    return ctx.knownFiles.has(norm);
  }
  if (!ctx.workspaceDir) return false;
  try {
    return statSync(resolve(ctx.workspaceDir, norm)).isFile();
  } catch {
    return false; // candidate path absent on disk
  }
}

function existsRepoPrefix(prefixDir: string, ctx: WorkspaceResolveContext): boolean {
  const norm = normalizePath(prefixDir);
  if (!norm) return false;
  const slash = `${norm}/`;
  if (ctx.extraFiles) {
    for (const f of ctx.extraFiles) {
      if (f.startsWith(slash)) return true;
    }
  }
  if (ctx.knownFiles) {
    for (const f of ctx.knownFiles) {
      if (f.startsWith(slash)) return true;
    }
    return false;
  }
  if (!ctx.workspaceDir) return false;
  try {
    return existsSync(resolve(ctx.workspaceDir, norm));
  } catch {
    return false; // directory probe failed
  }
}

function expandTsJsCandidatePaths(basePath: string): string[] {
  const norm = normalizePath(basePath);
  if (!norm) return [];

  // ESM TS conventions import `.js` / `.mjs` / `.cjs` while the file on disk is `.ts*`.
  if (norm.endsWith('.js')) {
    const stem = norm.slice(0, -3);
    return [norm, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`];
  }
  if (norm.endsWith('.jsx')) {
    const stem = norm.slice(0, -4);
    return [norm, `${stem}.tsx`, `${stem}.ts`, `${stem}.d.ts`];
  }
  if (norm.endsWith('.mjs')) {
    const stem = norm.slice(0, -4);
    return [norm, `${stem}.mts`, `${stem}.d.mts`];
  }
  if (norm.endsWith('.cjs')) {
    const stem = norm.slice(0, -4);
    return [norm, `${stem}.cts`, `${stem}.d.cts`];
  }

  const suffixCandidates = [
    `${norm}.ts`,
    `${norm}.tsx`,
    `${norm}.mts`,
    `${norm}.cts`,
    `${norm}.d.ts`,
    `${norm}.js`,
    `${norm}.jsx`,
    `${norm}.mjs`,
    `${norm}.cjs`,
    `${norm}/index.ts`,
    `${norm}/index.tsx`,
    `${norm}/index.d.ts`,
    `${norm}/index.js`,
    `${norm}/index.jsx`,
  ];
  // Put `.ts*`/`.js*`/index candidates before the extensionless path when no extension is present
  // so remote file probes check real file paths first.
  return /\.[^/]+$/.test(norm) ? [norm, ...suffixCandidates] : [...suffixCandidates, norm];
}

function resolveTsJsCandidate(basePath: string, ctx: WorkspaceResolveContext): string {
  const norm = normalizePath(basePath);
  const candidates = expandTsJsCandidatePaths(norm);
  for (const c of candidates) {
    if (existsRepoFile(c, ctx)) return c;
  }
  return norm;
}

interface BestTsConfigPathMatch {
  exact: boolean;
  prefixLen: number;
  suffixLen: number;
  wildcard: string;
  targets: string[];
}

function findBestTsConfigPathMatch(
  specifier: string,
  tsconfig: TsConfigPaths,
): BestTsConfigPathMatch | undefined {
  let best: BestTsConfigPathMatch | undefined;

  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (targets.length === 0) continue;
    const starIdx = pattern.indexOf('*');
    if (starIdx === -1) {
      if (specifier === pattern) {
        best = {
          exact: true,
          prefixLen: pattern.length,
          suffixLen: 0,
          wildcard: '',
          targets,
        };
        break;
      }
      continue;
    }
    if (pattern.indexOf('*', starIdx + 1) !== -1) continue;
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      if (
        !best ||
        prefix.length > best.prefixLen ||
        (prefix.length === best.prefixLen && suffix.length > best.suffixLen)
      ) {
        best = {
          exact: false,
          prefixLen: prefix.length,
          suffixLen: suffix.length,
          wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
          targets,
        };
      }
    }
  }

  return best;
}

/**
 * List candidate repo-relative file paths for a non-relative JS/TS specifier
 * under the parsed `tsconfig.paths` and `tsconfig.baseUrl` configuration.
 */
export function listTsConfigAliasCandidates(specifier: string, tsconfig: TsConfigPaths): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pushAll = (basePath: string): void => {
    for (const candidate of expandTsJsCandidatePaths(basePath)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  };

  const best = findBestTsConfigPathMatch(specifier, tsconfig);
  if (best) {
    for (const target of best.targets) {
      const substituted = best.exact ? target : target.replace('*', best.wildcard);
      pushAll(substituted);
    }
  }
  if (tsconfig.baseUrl) {
    const basePrefix = tsconfig.baseUrl !== '.' ? `${tsconfig.baseUrl}/` : '';
    pushAll(posix.join(basePrefix, specifier));
  }
  return out;
}

function matchTsConfigAlias(
  specifier: string,
  tsconfig: TsConfigPaths,
  ctx: WorkspaceResolveContext,
): string | undefined {
  const best = findBestTsConfigPathMatch(specifier, tsconfig);

  if (best) {
    const hasRepoTree = Boolean(ctx.knownFiles || ctx.workspaceDir);
    let firstSubstituted: string | undefined;
    for (const target of best.targets) {
      const substituted = best.exact ? target : target.replace('*', best.wildcard);
      firstSubstituted ??= substituted;
      const joined = normalizePath(substituted);
      const resolved = resolveTsJsCandidate(joined, ctx);
      if (existsRepoFile(resolved, ctx)) {
        return resolved;
      }
    }
    const isCatchAllWildcard = !best.exact && best.prefixLen === 0 && best.suffixLen === 0;
    if (!hasRepoTree && !isCatchAllWildcard && firstSubstituted !== undefined) {
      return normalizePath(firstSubstituted);
    }
  }

  if (tsconfig.baseUrl) {
    const basePrefix = tsconfig.baseUrl !== '.' ? `${tsconfig.baseUrl}/` : '';
    const joined = normalizePath(posix.join(basePrefix, specifier));
    const resolved = resolveTsJsCandidate(joined, ctx);
    if (existsRepoFile(resolved, ctx)) return resolved;
  }
  return undefined;
}

function extractNpmPackageName(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function joinRelativePosix(sourceFilePath: string, relSpec: string): string {
  const dir = posix.dirname(normalizePath(sourceFilePath));
  const raw = dir === '.' ? relSpec : posix.join(dir, relSpec);
  return normalizePath(posix.normalize(raw));
}

const KNOWN_EXTERNAL_JVM_PREFIXES = [
  'java.',
  'javax.',
  'jakarta.',
  'kotlin.',
  'kotlinx.',
  'scala.',
  'org.springframework.',
  'org.hibernate.',
  'io.ktor.',
  'org.junit.',
  'org.slf4j.',
  'com.fasterxml.',
];

function resolveRelativePythonSpec(
  specifier: string,
  normSource: string,
  ctx: WorkspaceResolveContext,
): { resolvedPath: string; matchedRepo: boolean } {
  const dotMatch = specifier.match(/^(\.+)(.*)$/);
  const dots = dotMatch?.[1]?.length ?? 1;
  const remainder = (dotMatch?.[2] ?? '').replace(/^\./, '').replace(/\./g, '/');
  let dir = posix.dirname(normSource);
  for (let i = 1; i < dots; i++) {
    dir = posix.dirname(dir);
  }
  const joined = normalizePath(
    dir === '.' ? remainder : remainder ? posix.join(dir, remainder) : dir,
  );
  const pyFile = `${joined}.py`;
  const pyInit = `${joined}/__init__.py`;
  if (existsRepoFile(pyFile, ctx)) return { resolvedPath: pyFile, matchedRepo: true };
  if (existsRepoFile(pyInit, ctx)) return { resolvedPath: pyInit, matchedRepo: true };
  if (existsRepoPrefix(joined, ctx)) return { resolvedPath: joined, matchedRepo: true };
  return { resolvedPath: joined, matchedRepo: false };
}

function resolveAbsolutePythonSpec(
  specifier: string,
  normSource: string,
  ctx: WorkspaceResolveContext,
): { resolvedPath?: string; packageName?: string; matchedRepo: boolean } {
  const modPath = specifier.replace(/\./g, '/');
  const candidates = [
    `${modPath}.py`,
    `${modPath}/__init__.py`,
    `src/${modPath}.py`,
    `src/${modPath}/__init__.py`,
  ];
  for (const c of candidates) {
    if (existsRepoFile(c, ctx)) return { resolvedPath: c, matchedRepo: true };
  }
  if (existsRepoPrefix(modPath, ctx)) {
    return { resolvedPath: modPath, matchedRepo: true };
  }
  if (existsRepoPrefix(`src/${modPath}`, ctx)) {
    return { resolvedPath: `src/${modPath}`, matchedRepo: true };
  }

  // Algebraic fallback when files aren't on disk: match top-level package
  // against the source file's own root package directory.
  const sourceSegs = normSource.split('/').filter(Boolean);
  const firstImportSeg = modPath.split('/')[0];
  if (firstImportSeg) {
    if (sourceSegs[0] === firstImportSeg) {
      return { resolvedPath: modPath, matchedRepo: false };
    }
    if (sourceSegs[0] === 'src' && sourceSegs[1] === firstImportSeg) {
      return { resolvedPath: `src/${modPath}`, matchedRepo: false };
    }
  }
  return { packageName: firstImportSeg ?? specifier, matchedRepo: false };
}

function resolveSinglePythonSpec(
  specifier: string,
  normSource: string,
  line: number,
  snippet: string,
  ctx: WorkspaceResolveContext,
): ResolvedImport {
  if (specifier.startsWith('.')) {
    const rel = resolveRelativePythonSpec(specifier, normSource, ctx);
    return {
      specifier,
      line,
      snippet,
      language: 'python',
      resolvedPath: rel.resolvedPath,
    };
  }
  const abs = resolveAbsolutePythonSpec(specifier, normSource, ctx);
  return {
    specifier,
    line,
    snippet,
    language: 'python',
    ...(abs.resolvedPath !== undefined ? { resolvedPath: abs.resolvedPath } : {}),
    ...(abs.packageName !== undefined ? { packageName: abs.packageName } : {}),
  };
}

function resolvePythonSubmodules(
  imp: ExtractedImport,
  normSource: string,
  ctx: WorkspaceResolveContext,
): ResolvedImport[] {
  if (!imp.importedNames || imp.importedNames.length === 0) {
    return [resolveSinglePythonSpec(imp.specifier, normSource, imp.line, imp.snippet, ctx)];
  }

  const hasRepoTree = Boolean(ctx.workspaceDir || ctx.knownFiles);
  const sourceSegs = normSource.split('/').filter(Boolean);
  const matchedSubs: ResolvedImport[] = [];
  let hasNonSubmodule = false;

  for (const item of imp.importedNames) {
    const subSpec = imp.specifier.endsWith('.')
      ? `${imp.specifier}${item.name}`
      : `${imp.specifier}.${item.name}`;

    if (subSpec.startsWith('.')) {
      const rel = resolveRelativePythonSpec(subSpec, normSource, ctx);
      if (rel.matchedRepo) {
        matchedSubs.push({
          specifier: subSpec,
          line: item.line,
          snippet: imp.snippet,
          language: 'python',
          resolvedPath: rel.resolvedPath,
        });
        continue;
      }
      hasNonSubmodule = true;
      continue;
    }

    const abs = resolveAbsolutePythonSpec(subSpec, normSource, ctx);
    if (abs.matchedRepo && abs.resolvedPath) {
      matchedSubs.push({
        specifier: subSpec,
        line: item.line,
        snippet: imp.snippet,
        language: 'python',
        resolvedPath: abs.resolvedPath,
      });
      continue;
    }

    // Without a repo tree (`ctx.knownFiles`/`workspaceDir`), treat a lowercase
    // name imported from a single-segment root matching this file's root
    // (e.g. `from src import infrastructure`) as a submodule, while leaving
    // class names and multi-segment module imports (`from pkg.mod import fn`)
    // anchored to `pkg.mod`.
    if (
      !hasRepoTree &&
      !imp.specifier.includes('.') &&
      /^[a-z][a-z0-9_]*$/.test(item.name) &&
      abs.resolvedPath
    ) {
      const matchesOwnRoot =
        sourceSegs[0] === imp.specifier ||
        (sourceSegs[0] === 'src' && sourceSegs[1] === imp.specifier);
      if (matchesOwnRoot) {
        matchedSubs.push({
          specifier: subSpec,
          line: item.line,
          snippet: imp.snippet,
          language: 'python',
          resolvedPath: abs.resolvedPath,
        });
        continue;
      }
    }

    hasNonSubmodule = true;
  }

  if (matchedSubs.length === 0) {
    return [resolveSinglePythonSpec(imp.specifier, normSource, imp.line, imp.snippet, ctx)];
  }
  if (hasNonSubmodule) {
    return [
      ...matchedSubs,
      resolveSinglePythonSpec(imp.specifier, normSource, imp.line, imp.snippet, ctx),
    ];
  }
  return matchedSubs;
}

/**
 * Resolve all {@link ExtractedImport} entries, flattening Python
 * `from pkg import submod1, submod2` statements into individual resolved paths.
 */
export function resolveImports(
  imports: readonly ExtractedImport[],
  sourceFilePath: string,
  ctx: WorkspaceResolveContext,
  fileMeta: FileImportMeta = {},
): ResolvedImport[] {
  const normSource = normalizePath(sourceFilePath);
  const out: ResolvedImport[] = [];
  for (const imp of imports) {
    if (imp.language === 'python') {
      out.push(...resolvePythonSubmodules(imp, normSource, ctx));
    } else {
      out.push(resolveImport(imp, sourceFilePath, ctx, fileMeta));
    }
  }
  return out;
}

function findRustCrateSrc(normSource: string): string {
  const srcIdx = normSource.lastIndexOf('/src/');
  if (srcIdx !== -1) return normSource.slice(0, srcIdx + 4);
  return normSource.startsWith('src/') ? 'src' : '';
}

function resolveRustModulePath(
  joined: string,
  crateRoot: string,
  ctx: WorkspaceResolveContext,
): string {
  const normJoined = normalizePath(joined);
  const normRoot = crateRoot ? normalizePath(crateRoot) : '';

  let candidate = normJoined;
  while (true) {
    if (normRoot && candidate !== normRoot && !candidate.startsWith(`${normRoot}/`)) {
      break;
    }
    if (candidate === normRoot) {
      const libRs = normRoot ? `${normRoot}/lib.rs` : 'lib.rs';
      if (existsRepoFile(libRs, ctx)) return libRs;
      const mainRs = normRoot ? `${normRoot}/main.rs` : 'main.rs';
      if (existsRepoFile(mainRs, ctx)) return mainRs;
      break;
    }
    if (candidate && candidate !== '.') {
      const rsFile = `${candidate}.rs`;
      if (existsRepoFile(rsFile, ctx)) return rsFile;
      const rsMod = `${candidate}/mod.rs`;
      if (existsRepoFile(rsMod, ctx)) return rsMod;
    }
    const slash = candidate.lastIndexOf('/');
    if (slash === -1) {
      if (normRoot === '' && candidate !== '') {
        candidate = '';
        continue;
      }
      break;
    }
    candidate = candidate.slice(0, slash);
  }

  return normJoined;
}

function rustLogicalModuleDir(normSource: string): string {
  // In Rust, `foo.rs` defines module `foo` (so child `mod bar;` lives at
  // `foo/bar.rs` or `foo/bar/mod.rs`), whereas `mod.rs`, `lib.rs`, and
  // `main.rs` correspond directly to their containing directory.
  const baseName = posix.basename(normSource);
  const isDirModule = baseName === 'mod.rs' || baseName === 'lib.rs' || baseName === 'main.rs';
  return isDirModule ? posix.dirname(normSource) : normSource.replace(/\.rs$/, '');
}

function existsCSharpTarget(candidate: string, ctx: WorkspaceResolveContext): string | undefined {
  if (existsRepoFile(`${candidate}.cs`, ctx)) return `${candidate}.cs`;
  if (existsRepoPrefix(candidate, ctx)) return candidate;
  return undefined;
}

function alignCSharpSpecCandidates(
  specSegs: readonly string[],
  dirSegs: readonly string[],
  pkgSegs: readonly string[],
): { candidates: string[]; fallbackPath?: string } {
  const candidates: string[] = [];
  let fallbackPath: string | undefined;

  // 1. SDK-style dotted project directory (e.g. `src/Acme.Domain/Order.cs` -> `src/Acme.Infrastructure`).
  for (let dirIdx = dirSegs.length - 1; dirIdx >= 0; dirIdx--) {
    const seg = dirSegs[dirIdx]!;
    if (!seg.includes('.')) continue;
    const maxSegs = Math.min(pkgSegs.length, seg.split('.').length);
    for (let m = maxSegs; m >= 2; m--) {
      if (pkgSegs.slice(0, m).join('.') !== seg) continue;
      if (pkgSegs[0] && specSegs[0] === pkgSegs[0]) {
        const dirPrefix = dirSegs.slice(0, dirIdx);
        const startCount = Math.min(m, specSegs.length);
        for (let sc = startCount; sc >= 2; sc--) {
          const mapped = [
            ...dirPrefix,
            specSegs.slice(0, sc).join('.'),
            ...specSegs.slice(sc),
          ].join('/');
          candidates.push(mapped);
          fallbackPath ??= mapped;
        }
      }
      return { candidates, fallbackPath };
    }
  }

  // 2. Nested directory layout sharing trailing segments with declared namespace
  // (e.g. `src/Domain/Order.cs` with `namespace Acme.Domain` -> `src/Infrastructure`).
  const maxOverlap = Math.min(pkgSegs.length, dirSegs.length);
  for (let k = maxOverlap; k >= 1; k--) {
    let matched = true;
    for (let i = 0; i < k; i++) {
      if (pkgSegs[pkgSegs.length - k + i] !== dirSegs[dirSegs.length - k + i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const nsPrefix = pkgSegs.slice(0, pkgSegs.length - k);
    const dirPrefix = dirSegs.slice(0, dirSegs.length - k);
    if (
      nsPrefix.length > 0 &&
      specSegs.length > nsPrefix.length &&
      nsPrefix.every((seg, idx) => specSegs[idx] === seg)
    ) {
      const mapped = [...dirPrefix, ...specSegs.slice(nsPrefix.length)].join('/');
      candidates.push(mapped);
      if (dirPrefix.length > 0) {
        fallbackPath = mapped;
      }
    }
    break;
  }

  return { candidates, fallbackPath };
}

function resolveCSharpImport(
  specifier: string,
  normSource: string,
  declaredPackage: string | undefined,
  ctx: WorkspaceResolveContext,
): { resolvedPath?: string; packageName?: string } {
  if (ctx.csharpNamespaces) {
    const exact = ctx.csharpNamespaces.get(specifier);
    if (exact) return { resolvedPath: exact };
  }

  const nsPath = specifier.replace(/\./g, '/');
  const directHit = existsCSharpTarget(nsPath, ctx);
  if (directHit) return { resolvedPath: directHit };

  let alignedFallback: string | undefined;
  let sameRoot = false;
  if (declaredPackage) {
    const pkgSegs = declaredPackage.split('.');
    const specSegs = specifier.split('.');
    const rootNs = pkgSegs[0];
    sameRoot = Boolean(
      rootNs && specSegs[0] === rootNs && rootNs !== 'System' && rootNs !== 'Microsoft',
    );

    const sourceDir = posix.dirname(normSource);
    const dirSegs = sourceDir === '.' ? [] : sourceDir.split('/');
    const aligned = alignCSharpSpecCandidates(specSegs, dirSegs, pkgSegs);
    for (const candidate of aligned.candidates) {
      const hit = existsCSharpTarget(candidate, ctx);
      if (hit) return { resolvedPath: hit };
    }
    if (sameRoot) {
      alignedFallback = aligned.fallbackPath;
    }
  }

  if (ctx.csharpNamespaces) {
    let prefix = specifier;
    while (prefix.includes('.')) {
      prefix = prefix.slice(0, prefix.lastIndexOf('.'));
      const parentMatch = ctx.csharpNamespaces.get(prefix);
      if (parentMatch) return { resolvedPath: parentMatch };
    }
  }

  if (sameRoot) {
    return { resolvedPath: alignedFallback ?? nsPath };
  }
  return { packageName: specifier };
}

/**
 * Resolve an {@link ExtractedImport} into either an internal repo-relative path
 * or an external package identifier.
 */
export function resolveImport(
  imp: ExtractedImport,
  sourceFilePath: string,
  ctx: WorkspaceResolveContext,
  fileMeta: FileImportMeta = {},
): ResolvedImport {
  const base: ResolvedImport = {
    specifier: imp.specifier,
    line: imp.line,
    snippet: imp.snippet,
    language: imp.language,
  };
  const normSource = normalizePath(sourceFilePath);

  switch (imp.language) {
    case 'typescript':
    case 'javascript': {
      if (imp.specifier.startsWith('./') || imp.specifier.startsWith('../')) {
        const joined = joinRelativePosix(normSource, imp.specifier);
        return { ...base, resolvedPath: resolveTsJsCandidate(joined, ctx) };
      }
      if (ctx.tsconfig) {
        const aliased = matchTsConfigAlias(imp.specifier, ctx.tsconfig, ctx);
        if (aliased) return { ...base, resolvedPath: aliased };
      }
      return { ...base, packageName: extractNpmPackageName(imp.specifier) };
    }

    case 'go': {
      if (ctx.goModule) {
        if (imp.specifier === ctx.goModule) {
          return { ...base, resolvedPath: '.' };
        }
        if (imp.specifier.startsWith(`${ctx.goModule}/`)) {
          return {
            ...base,
            resolvedPath: normalizePath(imp.specifier.slice(ctx.goModule.length + 1)),
          };
        }
      }
      return { ...base, packageName: imp.specifier };
    }

    case 'dart': {
      if (imp.specifier.startsWith('dart:')) {
        return { ...base, packageName: imp.specifier };
      }
      if (imp.specifier.startsWith('package:')) {
        const rest = imp.specifier.slice('package:'.length);
        const slash = rest.indexOf('/');
        const pkg = slash === -1 ? rest : rest.slice(0, slash);
        const subpath = slash === -1 ? '' : rest.slice(slash + 1);
        if (ctx.dartPackage && pkg === ctx.dartPackage) {
          return { ...base, resolvedPath: normalizePath(`lib/${subpath}`) };
        }
        return { ...base, packageName: pkg };
      }
      return { ...base, resolvedPath: joinRelativePosix(normSource, imp.specifier) };
    }

    case 'python': {
      return resolvePythonSubmodules(imp, normSource, ctx)[0]!;
    }

    case 'rust': {
      if (imp.specifier.startsWith('mod:')) {
        const modName = imp.specifier.slice(4);
        const dir = rustLogicalModuleDir(normSource);
        const direct = normalizePath(dir === '.' ? `${modName}.rs` : `${dir}/${modName}.rs`);
        const nested = normalizePath(
          dir === '.' ? `${modName}/mod.rs` : `${dir}/${modName}/mod.rs`,
        );
        if (existsRepoFile(nested, ctx)) return { ...base, resolvedPath: nested };
        return { ...base, resolvedPath: direct };
      }
      if (imp.specifier.startsWith('crate::')) {
        const rel = imp.specifier.slice('crate::'.length).replace(/::/g, '/');
        const crateSrc = findRustCrateSrc(normSource);
        const joined = normalizePath(crateSrc ? `${crateSrc}/${rel}` : rel);
        return {
          ...base,
          resolvedPath: resolveRustModulePath(joined, crateSrc, ctx),
        };
      }
      if (imp.specifier.startsWith('super::') || imp.specifier.startsWith('self::')) {
        // `self::` starts at the declaring file's logical module path and each
        // `super::` climbs one logical module level.
        let modDir = rustLogicalModuleDir(normSource);
        let rest = imp.specifier;
        if (rest.startsWith('self::')) {
          rest = rest.slice('self::'.length);
        }
        while (rest.startsWith('super::')) {
          rest = rest.slice('super::'.length);
          modDir = posix.dirname(modDir);
        }
        const rel = rest.replace(/::/g, '/');
        const joined = normalizePath(modDir === '.' ? rel : posix.join(modDir, rel));
        const crateSrc = findRustCrateSrc(normSource);
        return {
          ...base,
          resolvedPath: resolveRustModulePath(joined, crateSrc, ctx),
        };
      }
      const crateName = imp.specifier.split('::')[0] ?? imp.specifier;
      return { ...base, packageName: crateName };
    }

    case 'java':
    case 'kotlin': {
      const isWildcard = imp.specifier.endsWith('.*');
      const cleanSpec = imp.specifier.replace(/\.\*$/, '');
      const specPath = cleanSpec.replace(/\./g, '/');
      const sourceRoot = findJvmSourceRoot(normSource, fileMeta.declaredPackage);
      const prefix = sourceRoot ? `${sourceRoot}/` : '';

      if (imp.language === 'kotlin' && !isWildcard && ctx.kotlinSymbols) {
        const exact = ctx.kotlinSymbols.get(cleanSpec);
        if (exact) return { ...base, resolvedPath: exact };
      }

      const exts = imp.language === 'java' ? ['java'] : ['kt', 'kts', 'java'];
      for (const ext of exts) {
        const candidate = `${prefix}${specPath}.${ext}`;
        if (existsRepoFile(candidate, ctx)) return { ...base, resolvedPath: candidate };
      }

      if (!isWildcard) {
        const crossRootFile = findJvmFileAcrossRoots(specPath, exts, ctx);
        if (crossRootFile) return { ...base, resolvedPath: crossRootFile };
      }

      if (imp.language === 'kotlin' && !isWildcard && ctx.kotlinSymbols) {
        let symbolPrefix = cleanSpec;
        while (symbolPrefix.includes('.')) {
          symbolPrefix = symbolPrefix.slice(0, symbolPrefix.lastIndexOf('.'));
          const parentHit = ctx.kotlinSymbols.get(symbolPrefix);
          if (parentHit) return { ...base, resolvedPath: parentHit };
        }
      }

      if (!isWildcard && specPath.includes('/')) {
        let parentPath = specPath;
        while (parentPath.includes('/')) {
          parentPath = parentPath.slice(0, parentPath.lastIndexOf('/'));
          for (const ext of exts) {
            const candidate = `${prefix}${parentPath}.${ext}`;
            if (existsRepoFile(candidate, ctx)) return { ...base, resolvedPath: candidate };
          }
          const crossParent = findJvmFileAcrossRoots(parentPath, exts, ctx);
          if (crossParent) return { ...base, resolvedPath: crossParent };
        }
      }

      if (existsRepoPrefix(`${prefix}${specPath}`, ctx)) {
        return { ...base, resolvedPath: `${prefix}${specPath}` };
      }
      const crossPkgDirs = findJvmPackageDirsInTree(specPath, ctx);
      if (crossPkgDirs.length > 0) {
        return { ...base, resolvedPath: crossPkgDirs[0]! };
      }

      if (!isWildcard && specPath.includes('/')) {
        const lastSlash = specPath.lastIndexOf('/');
        const pkgPath = specPath.slice(0, lastSlash);
        const symName = specPath.slice(lastSlash + 1);
        const enclosingDirs = findJvmPackageDirsInTree(pkgPath, ctx);
        if (enclosingDirs.length > 0) {
          return { ...base, resolvedPath: `${enclosingDirs[0]!}/${symName}` };
        }
      }

      if (
        fileMeta.declaredPackage &&
        !KNOWN_EXTERNAL_JVM_PREFIXES.some((p) => cleanSpec.startsWith(p))
      ) {
        const pkgSegs = fileMeta.declaredPackage.split('.');
        const specSegs = cleanSpec.split('.');
        const sameRoot =
          pkgSegs.length >= 2 &&
          specSegs.length >= 2 &&
          pkgSegs[0] === specSegs[0] &&
          pkgSegs[1] === specSegs[1];
        if (sameRoot) {
          return { ...base, resolvedPath: `${prefix}${specPath}` };
        }
      }
      return { ...base, packageName: imp.specifier };
    }

    case 'csharp': {
      const resolved = resolveCSharpImport(
        imp.specifier,
        normSource,
        fileMeta.declaredPackage,
        ctx,
      );
      return { ...base, ...resolved };
    }
  }
}
