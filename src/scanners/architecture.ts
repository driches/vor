/**
 * Concrete `Scanner` for deterministic software architecture boundary
 * enforcement on PR-added lines.
 *
 * Mirrors the other custom scanners (`debris.ts`, `migration-safety.ts`):
 *   - Runs at zero LLM cost in parallel with the agent.
 *   - Evaluates only PR-added lines (`file.added_lines`) so pre-existing
 *     violations in untouched lines do not pollute unrelated PRs.
 *   - Honors `.vor/security-ignore.yml` suppressions (`file` + `rule`).
 *   - Never throws; per-file failures become non-fatal `ScanError` entries.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { evaluateFileArchitecture } from '../architecture/evaluator.js';
import { isTestFile, matchesAnyGlob, normalizePath } from '../architecture/glob.js';
import {
  buildCSharpNamespaceMap,
  detectArchLanguage,
  extractCSharpNamespace,
  extractImports,
  extractKotlinDeclarations,
  extractTsConfigExtends,
  findJvmPackageDirsInTree,
  findJvmSourceRoot,
  listTsConfigAliasCandidates,
  loadWorkspaceResolveContext,
  parseGoModModule,
  parsePubspecName,
  parseTsConfigContent,
  resolveImport,
  type ArchLanguage,
  type WorkspaceResolveContext,
} from '../architecture/imports.js';
import type { ResolvedArchitectureSpec } from '../architecture/presets.js';
import type { ChangedFile, ScannerId } from '../types.js';
import { logger as defaultLogger } from '../util/logger.js';
import { expiredIgnoreNotice } from './ignore-list.js';
import {
  emptyResult,
  type ScanError,
  type ScanFinding,
  type ScanResult,
  type Scanner,
  type ScannerDeps,
} from './types.js';

const SCANNER_ID: ScannerId = 'architecture';

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface ArchitectureScannerOptions {
  logger?: Logger;
}

interface ScanCounters {
  networkCalls: number;
  cacheHits: number;
}

function reconstructFromHeadLines(file: ChangedFile): string {
  if (file.head_line_text.size === 0) return '';
  let maxLine = 0;
  for (const ln of file.head_line_text.keys()) {
    if (ln > maxLine) maxLine = ln;
  }
  const lines = new Array<string>(maxLine).fill('');
  for (const [ln, text] of file.head_line_text) {
    if (ln >= 1) lines[ln - 1] = text;
  }
  // head_line_text only contains added (+) and context lines from diff hunks,
  // not the full file; callers prefer remote API and disk reads above this fallback.
  return lines.join('\n');
}

async function readHeadFileContent(
  deps: ScannerDeps,
  file: ChangedFile,
  counters: ScanCounters,
): Promise<string> {
  try {
    counters.networkCalls += 1;
    const remote = await deps.fileReader.read({
      owner: deps.owner,
      repo: deps.repo,
      path: file.path,
      ref: deps.head_sha,
    });
    if (remote !== null) return remote;
  } catch {
    // Fall back to workspace disk or diff hunk lines below.
  }

  if (deps.workspaceDir) {
    try {
      return readFileSync(resolve(deps.workspaceDir, file.path), 'utf-8');
    } catch {
      // File may not exist in workspace during API-only reviews.
    }
  }

  return reconstructFromHeadLines(file);
}

type MetadataReadResult =
  | { status: 'found'; content: string }
  | { status: 'absent' }
  | { status: 'error' };

async function readMetadataFile(
  deps: ScannerDeps,
  path: string,
  counters: ScanCounters,
  headTree: ReadonlySet<string> | null,
  removedFiles: ReadonlySet<string>,
): Promise<MetadataReadResult> {
  const norm = normalizePath(path);
  if (removedFiles.has(norm) || (headTree !== null && !headTree.has(norm))) {
    return { status: 'absent' };
  }
  try {
    counters.networkCalls += 1;
    const raw = await deps.fileReader.read({
      owner: deps.owner,
      repo: deps.repo,
      path: norm,
      ref: deps.head_sha,
    });
    return raw !== null ? { status: 'found', content: raw } : { status: 'absent' };
  } catch {
    return { status: 'error' }; // transient error allows checkout fallback in caller
  }
}

async function hydrateTsConfigFromHead(
  deps: ScannerDeps,
  headRaw: string,
  counters: ScanCounters,
  headTree: ReadonlySet<string> | null,
  removedFiles: ReadonlySet<string>,
): Promise<ReturnType<typeof parseTsConfigContent>> {
  const preloaded = new Map<string, string | null>();

  // Pre-fetch up to two relative `extends` hops from PR HEAD (falling back to
  // the local checkout only on transient read errors, never when HEAD confirms
  // the extended config is absent) so synchronous `parseTsConfigContent` uses
  // aliases from the reviewed commit rather than an older checkout.
  const queue: Array<{ raw: string; dir: string; depth: number }> = [
    { raw: headRaw, dir: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= 2) continue;
    for (const extPath of extractTsConfigExtends(item.raw)) {
      const joined = normalizePath(
        item.dir && item.dir !== '.' ? posix.join(item.dir, extPath) : extPath,
      );
      if (!joined || joined === '..' || joined.startsWith('../') || preloaded.has(joined)) {
        continue;
      }
      const candidates = joined.endsWith('.json') ? [joined] : [joined, `${joined}.json`];
      let foundRaw: string | null = null;
      let foundPath = joined;
      for (const candidate of candidates) {
        let rawCandidate: string | null = null;
        if (preloaded.has(candidate)) {
          rawCandidate = preloaded.get(candidate) ?? null;
        } else {
          const readRes = await readMetadataFile(deps, candidate, counters, headTree, removedFiles);
          if (readRes.status === 'found') {
            rawCandidate = readRes.content;
          } else if (readRes.status === 'error' && deps.workspaceDir) {
            try {
              rawCandidate = readFileSync(resolve(deps.workspaceDir, candidate), 'utf-8');
            } catch {
              rawCandidate = null; // extended tsconfig missing locally too
            }
          }
          preloaded.set(candidate, rawCandidate);
        }
        if (rawCandidate !== null) {
          foundRaw = rawCandidate;
          foundPath = candidate;
          break;
        }
      }
      if (foundRaw) {
        const nextDir = posix.dirname(foundPath);
        queue.push({ raw: foundRaw, dir: nextDir === '.' ? '' : nextDir, depth: item.depth + 1 });
      }
    }
  }

  return parseTsConfigContent(headRaw, (relPath) => {
    const norm = normalizePath(relPath);
    if (preloaded.has(norm)) return preloaded.get(norm) ?? null;
    if (removedFiles.has(norm) || (headTree !== null && !headTree.has(norm))) {
      return null;
    }
    if (deps.workspaceDir) {
      try {
        return readFileSync(resolve(deps.workspaceDir, norm), 'utf-8');
      } catch {
        return null; // optional extended tsconfig missing on disk
      }
    }
    return null;
  });
}

async function fetchHeadTreeFiles(
  deps: ScannerDeps,
  counters: ScanCounters,
): Promise<Set<string> | null> {
  if (typeof deps.octokit?.rest?.git?.getTree !== 'function' || deps.signal.aborted) {
    return null;
  }
  try {
    counters.networkCalls += 1;
    const res = await deps.octokit.rest.git.getTree({
      owner: deps.owner,
      repo: deps.repo,
      tree_sha: deps.head_sha,
      recursive: '1',
      request: { signal: deps.signal },
    });
    if (res.data.truncated) return null;
    const files = new Set<string>();
    for (const entry of res.data.tree) {
      if (entry.type === 'blob' && entry.path) {
        const norm = normalizePath(entry.path);
        if (norm) files.add(norm);
      }
    }
    return files;
  } catch {
    return null; // fall back to checkout / fileReader candidate probing
  }
}

async function probeHeadAliasTargets(
  deps: ScannerDeps,
  filePath: string,
  content: string,
  onlyLines: ReadonlySet<number>,
  resolveCtx: WorkspaceResolveContext,
  probeCache: Map<string, boolean>,
  probeBudget: { remaining: number },
  counters: ScanCounters,
): Promise<void> {
  if (resolveCtx.knownFiles || !resolveCtx.tsconfig) return;
  const lang = detectArchLanguage(filePath);
  if (lang !== 'typescript' && lang !== 'javascript') return;

  const { imports } = extractImports(filePath, content);
  const relevant = imports.filter(
    (imp) =>
      onlyLines.has(imp.line) &&
      !imp.specifier.startsWith('./') &&
      !imp.specifier.startsWith('../') &&
      !imp.specifier.startsWith('node:'),
  );
  if (relevant.length === 0) return;

  const mutableExtra = resolveCtx.extraFiles ? new Set(resolveCtx.extraFiles) : new Set<string>();
  let extraUpdated = false;

  for (const imp of relevant) {
    if (resolveImport(imp, filePath, resolveCtx).resolvedPath) continue;
    const candidates = listTsConfigAliasCandidates(imp.specifier, resolveCtx.tsconfig);
    for (const candidate of candidates) {
      if (deps.signal.aborted) break;
      let exists = probeCache.get(candidate);
      if (exists === undefined) {
        if (probeBudget.remaining <= 0) break;
        probeBudget.remaining -= 1;
        counters.networkCalls += 1;
        try {
          const hit = await deps.fileReader.read({
            owner: deps.owner,
            repo: deps.repo,
            path: candidate,
            ref: deps.head_sha,
          });
          exists = hit !== null;
        } catch {
          exists = false; // treat transient probe error as absent
        }
        probeCache.set(candidate, exists);
      } else {
        counters.cacheHits += 1;
      }
      if (exists) {
        mutableExtra.add(candidate);
        resolveCtx.extraFiles = mutableExtra;
        extraUpdated = true;
        break;
      }
    }
    if (probeBudget.remaining <= 0 || deps.signal.aborted) break;
  }

  if (extraUpdated) {
    resolveCtx.extraFiles = mutableExtra;
  }
}

function hasKotlinSymbolMatch(symbols: ReadonlyMap<string, string>, cleanSpec: string): boolean {
  if (symbols.has(cleanSpec)) return true;
  let prefix = cleanSpec;
  while (prefix.includes('.')) {
    prefix = prefix.slice(0, prefix.lastIndexOf('.'));
    if (symbols.has(prefix)) return true;
  }
  return false;
}

async function probeHeadKotlinSymbols(
  deps: ScannerDeps,
  filePath: string,
  content: string,
  onlyLines: ReadonlySet<number>,
  resolveCtx: WorkspaceResolveContext,
  indexedKotlinFiles: Set<string>,
  probeBudget: { remaining: number },
  counters: ScanCounters,
): Promise<void> {
  if (detectArchLanguage(filePath) !== 'kotlin') return;
  if (probeBudget.remaining <= 0 || deps.signal.aborted) return;

  const normSource = normalizePath(filePath);
  const { imports, meta } = extractImports(normSource, content);
  const relevant = imports.filter(
    (imp) => onlyLines.has(imp.line) && !imp.specifier.endsWith('.*'),
  );
  if (relevant.length === 0) return;

  const sourceRoot = findJvmSourceRoot(normSource, meta.declaredPackage);
  const prefix = sourceRoot ? `${sourceRoot}/` : '';

  const mutableSymbols = resolveCtx.kotlinSymbols
    ? new Map(resolveCtx.kotlinSymbols)
    : new Map<string, string>();
  const targetDirs = new Set<string>();
  const pendingSpecs: string[] = [];

  const fileSets: Array<ReadonlySet<string>> = [];
  if (resolveCtx.knownFiles) fileSets.push(resolveCtx.knownFiles);
  if (resolveCtx.extraFiles) fileSets.push(resolveCtx.extraFiles);

  const hasExactFile = (spec: string): boolean => {
    const specPath = spec.replace(/\./g, '/');
    for (const ext of ['kt', 'kts', 'java']) {
      const candidate = `${prefix}${specPath}.${ext}`;
      if (fileSets.some((s) => s.has(candidate))) return true;
    }
    return false;
  };

  for (const imp of relevant) {
    if (hasKotlinSymbolMatch(mutableSymbols, imp.specifier)) continue;
    if (hasExactFile(imp.specifier)) continue;
    pendingSpecs.push(imp.specifier);

    const segs = imp.specifier.split('.');
    if (segs.length >= 2) {
      const parentPkgPath = segs.slice(0, -1).join('/');
      const parentDir = normalizePath(`${prefix}${parentPkgPath}`);
      if (parentDir) targetDirs.add(parentDir);
      for (const dir of findJvmPackageDirsInTree(parentPkgPath, resolveCtx)) {
        targetDirs.add(dir);
      }
    }
    if (segs.length >= 3) {
      const grandPkgPath = segs.slice(0, -2).join('/');
      const grandDir = normalizePath(`${prefix}${grandPkgPath}`);
      if (grandDir) targetDirs.add(grandDir);
      for (const dir of findJvmPackageDirsInTree(grandPkgPath, resolveCtx)) {
        targetDirs.add(dir);
      }
    }
  }
  if (targetDirs.size === 0 || pendingSpecs.length === 0) return;

  const directChildren: string[] = [];
  const nestedChildren: string[] = [];
  const seenCandidates = new Set<string>();
  const addCandidate = (cand: string, isDirect: boolean): void => {
    if (indexedKotlinFiles.has(cand) || seenCandidates.has(cand)) return;
    seenCandidates.add(cand);
    if (isDirect) directChildren.push(cand);
    else nestedChildren.push(cand);
  };

  if (fileSets.length > 0) {
    const dirList = [...targetDirs];
    for (const set of fileSets) {
      for (const f of set) {
        if (!/\.(?:kt|kts)$/i.test(f)) continue;
        for (const dir of dirList) {
          const slash = `${dir}/`;
          if (!f.startsWith(slash)) continue;
          const rest = f.slice(slash.length);
          addCandidate(f, !rest.includes('/'));
          break;
        }
      }
    }
  }

  // Fallback when `git.getTree` is absent or truncated: probe standard public entrypoint files.
  if (!resolveCtx.knownFiles) {
    for (const dir of targetDirs) {
      addCandidate(`${dir}/index.kt`, true);
      addCandidate(`${dir}/index.kts`, true);
    }
  }

  directChildren.sort();
  nestedChildren.sort();
  const candidates = [...directChildren, ...nestedChildren];

  for (const candidate of candidates) {
    if (probeBudget.remaining <= 0 || deps.signal.aborted) break;
    if (pendingSpecs.every((s) => hasKotlinSymbolMatch(mutableSymbols, s))) break;
    indexedKotlinFiles.add(candidate);
    probeBudget.remaining -= 1;
    counters.networkCalls += 1;

    try {
      const hit = await deps.fileReader.read({
        owner: deps.owner,
        repo: deps.repo,
        path: candidate,
        ref: deps.head_sha,
      });
      if (!hit) continue;
      const decl = extractKotlinDeclarations(hit);
      if (!decl.packageName) continue;
      for (const sym of decl.symbols) {
        const fqn = `${decl.packageName}.${sym}`;
        if (!mutableSymbols.has(fqn)) {
          mutableSymbols.set(fqn, candidate);
        }
      }
      resolveCtx.kotlinSymbols = mutableSymbols;
    } catch {
      continue; // treat transient probe error as absent
    }
  }
}

async function hydrateResolveContext(
  deps: ScannerDeps,
  languagesPresent: ReadonlySet<ArchLanguage>,
  counters: ScanCounters,
): Promise<{ ctx: WorkspaceResolveContext; removedFiles: Set<string> }> {
  const ctx = loadWorkspaceResolveContext(deps.workspaceDir);
  const headTree = await fetchHeadTreeFiles(deps, counters);
  if (headTree) {
    ctx.knownFiles = headTree;
  }
  const removedFiles = new Set<string>();
  const prFiles: string[] = [];
  for (const f of deps.changedFiles) {
    const norm = normalizePath(f.path);
    if (f.status === 'removed') {
      removedFiles.add(norm);
    } else {
      prFiles.push(norm);
      if (f.status === 'renamed' && f.previous_path) {
        const prevNorm = normalizePath(f.previous_path);
        if (prevNorm && prevNorm !== norm) removedFiles.add(prevNorm);
      }
    }
  }
  if (prFiles.length > 0) {
    ctx.extraFiles = new Set(prFiles);
  }

  if (languagesPresent.has('typescript') || languagesPresent.has('javascript')) {
    const res = await readMetadataFile(deps, 'tsconfig.json', counters, headTree, removedFiles);
    if (res.status === 'found') {
      const parsed = await hydrateTsConfigFromHead(
        deps,
        res.content,
        counters,
        headTree,
        removedFiles,
      );
      if (parsed) ctx.tsconfig = parsed;
      else delete ctx.tsconfig;
    } else if (res.status === 'absent') {
      // Clear stale checkout metadata when tsconfig.json is confirmed absent at PR HEAD.
      delete ctx.tsconfig;
    }
  }

  if (languagesPresent.has('go')) {
    const res = await readMetadataFile(deps, 'go.mod', counters, headTree, removedFiles);
    if (res.status === 'found') {
      const goModule = parseGoModModule(res.content);
      if (goModule) ctx.goModule = goModule;
      else delete ctx.goModule;
    } else if (res.status === 'absent') {
      delete ctx.goModule;
    }
  }

  if (languagesPresent.has('dart')) {
    const res = await readMetadataFile(deps, 'pubspec.yaml', counters, headTree, removedFiles);
    if (res.status === 'found') {
      const dartPkg = parsePubspecName(res.content);
      if (dartPkg) ctx.dartPackage = dartPkg;
      else delete ctx.dartPackage;
    } else if (res.status === 'absent') {
      delete ctx.dartPackage;
    }
  }

  return { ctx, removedFiles };
}

const MAX_CSHARP_DISK_INDEX_FILES = 2000;
const MAX_CSHARP_INDEX_FILE_BYTES = 512 * 1024;
const CSHARP_WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vor',
  'target',
  'vendor',
  '.next',
  'out',
  'bin',
  'obj',
  '.dart_tool',
  '__pycache__',
  '.venv',
  'venv',
]);

function walkWorkspaceCSharpFiles(workspaceDir: string): string[] {
  const results: string[] = [];
  const walk = (absDir: string, relBase: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (CSHARP_WALK_SKIP_DIRS.has(entry.name)) continue;
      const abs = resolve(absDir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && /\.cs$/i.test(entry.name)) {
        results.push(normalizePath(rel));
      }
    }
  };
  walk(workspaceDir, '');
  return results;
}

async function hydrateHeadCSharpNamespaces(
  deps: ScannerDeps,
  applicableCSharpFiles: readonly ChangedFile[],
  resolveCtx: WorkspaceResolveContext,
  removedFiles: ReadonlySet<string>,
  headContentCache: Map<string, string>,
  probeBudget: { remaining: number },
  counters: ScanCounters,
): Promise<void> {
  if (applicableCSharpFiles.length === 0 || deps.signal.aborted) return;

  const fileNamespaces = new Map<string, string>();
  const indexedPaths = new Set<string>();
  const addedSpecs = new Set<string>();

  const recordCSharpContent = (normPath: string, content: string): void => {
    indexedPaths.add(normPath);
    const ns = extractCSharpNamespace(content);
    if (ns) fileNamespaces.set(normPath, ns);
  };

  for (const file of applicableCSharpFiles) {
    if (deps.signal.aborted) break;
    const norm = normalizePath(file.path);
    const content = headContentCache.get(norm) ?? (await readHeadFileContent(deps, file, counters));
    headContentCache.set(norm, content);
    indexedPaths.add(norm);
    const { imports, meta } = extractImports(norm, content);
    if (meta.declaredPackage) fileNamespaces.set(norm, meta.declaredPackage);
    for (const imp of imports) {
      if (file.added_lines.has(imp.line)) {
        addedSpecs.add(imp.specifier);
      }
    }
  }
  if (addedSpecs.size === 0 || deps.signal.aborted) return;

  // Also index other PR-changed `.cs` files (e.g. test files or files with only deletions)
  // at PR HEAD so their namespaces override any stale workspace copies.
  for (const file of deps.changedFiles) {
    if (deps.signal.aborted) break;
    if (file.status === 'removed' || file.is_binary || detectArchLanguage(file.path) !== 'csharp') {
      continue;
    }
    const norm = normalizePath(file.path);
    if (indexedPaths.has(norm)) continue;
    const content = headContentCache.get(norm) ?? (await readHeadFileContent(deps, file, counters));
    headContentCache.set(norm, content);
    recordCSharpContent(norm, content);
  }

  const unchangedCandidates: string[] = [];
  if (resolveCtx.knownFiles) {
    for (const f of resolveCtx.knownFiles) {
      if (!/\.cs$/i.test(f)) continue;
      if (indexedPaths.has(f) || removedFiles.has(f)) continue;
      unchangedCandidates.push(f);
    }
  } else if (deps.workspaceDir) {
    for (const f of walkWorkspaceCSharpFiles(deps.workspaceDir)) {
      if (indexedPaths.has(f) || removedFiles.has(f)) continue;
      unchangedCandidates.push(f);
    }
  }

  const prodCandidates: string[] = [];
  const testCandidates: string[] = [];
  for (const f of unchangedCandidates) {
    if (isTestFile(f)) testCandidates.push(f);
    else prodCandidates.push(f);
  }
  prodCandidates.sort();
  testCandidates.sort();
  const orderedUnchanged = [...prodCandidates, ...testCandidates];

  const remoteCandidates: string[] = [];
  if (deps.workspaceDir) {
    const wsRoot = resolve(deps.workspaceDir);
    let diskScanned = 0;
    for (const relPath of orderedUnchanged) {
      if (diskScanned >= MAX_CSHARP_DISK_INDEX_FILES) break;
      try {
        const abs = resolve(wsRoot, relPath);
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_CSHARP_INDEX_FILE_BYTES) continue;
        const content = readFileSync(abs, 'utf-8');
        diskScanned += 1;
        recordCSharpContent(relPath, content);
      } catch {
        remoteCandidates.push(relPath);
      }
    }
  } else {
    remoteCandidates.push(...orderedUnchanged);
  }

  if (remoteCandidates.length > 0 && probeBudget.remaining > 0 && !deps.signal.aborted) {
    const searchTokens = new Set<string>();
    for (const spec of addedSpecs) {
      if (
        spec === 'System' ||
        spec.startsWith('System.') ||
        spec === 'Microsoft' ||
        spec.startsWith('Microsoft.')
      ) {
        continue;
      }
      for (const seg of spec.split('.')) {
        if (seg.length >= 2) searchTokens.add(seg.toLowerCase());
      }
    }

    const prioritized: string[] = [];
    const deferred: string[] = [];
    for (const cand of remoteCandidates) {
      const lower = cand.toLowerCase();
      let matched = false;
      for (const tok of searchTokens) {
        if (lower.includes(tok)) {
          matched = true;
          break;
        }
      }
      if (matched) prioritized.push(cand);
      else deferred.push(cand);
    }

    for (const cand of [...prioritized, ...deferred]) {
      if (probeBudget.remaining <= 0 || deps.signal.aborted) break;
      probeBudget.remaining -= 1;
      counters.networkCalls += 1;
      try {
        const content = await deps.fileReader.read({
          owner: deps.owner,
          repo: deps.repo,
          path: cand,
          ref: deps.head_sha,
        });
        if (content !== null) {
          recordCSharpContent(cand, content);
        }
      } catch {
        continue; // treat transient probe failure as absent
      }
    }
  }

  if (fileNamespaces.size > 0) {
    resolveCtx.csharpNamespaces = buildCSharpNamespaceMap(fileNamespaces);
  }
}

function isFileApplicable(file: ChangedFile, spec: ResolvedArchitectureSpec): boolean {
  if (file.status === 'removed' || file.is_binary || file.is_generated) return false;
  if (detectArchLanguage(file.path) === null) return false;
  if (spec.ignore_tests && isTestFile(file.path)) return false;
  // Intentionally check only `spec.exclude` here; global `exclude.paths` gates LLM
  // review scope (`src/agent/pr-scope.ts`) while deterministic scanners still run on them.
  if (matchesAnyGlob(file.path, spec.exclude)) return false;
  return true;
}

export function createArchitectureScanner(
  spec: ResolvedArchitectureSpec,
  options: ArchitectureScannerOptions = {},
): Scanner {
  const log = options.logger ?? defaultLogger;

  const hasDeterministicRules =
    spec.enabled &&
    spec.deterministic_enforcement &&
    (Object.keys(spec.layers).length > 0 || spec.contexts !== undefined || spec.rules.length > 0);

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      if (!hasDeterministicRules) return false;
      return files.some((f) => isFileApplicable(f, spec));
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      if (!hasDeterministicRules) {
        return emptyResult(SCANNER_ID, Date.now() - started);
      }

      const applicable = deps.changedFiles.filter(
        (f) => f.added_lines.size > 0 && isFileApplicable(f, spec),
      );
      if (applicable.length === 0) {
        return emptyResult(SCANNER_ID, Date.now() - started);
      }

      const languagesPresent = new Set<ArchLanguage>();
      for (const f of applicable) {
        const lang = detectArchLanguage(f.path);
        if (lang) languagesPresent.add(lang);
      }

      const counters: ScanCounters = { networkCalls: 0, cacheHits: 0 };
      const { ctx: resolveCtx, removedFiles } = await hydrateResolveContext(
        deps,
        languagesPresent,
        counters,
      );
      const probeCache = new Map<string, boolean>();
      const indexedKotlinFiles = new Set<string>();
      const headContentCache = new Map<string, string>();
      const probeBudget = { remaining: 64 };
      const findings: ScanFinding[] = [];
      const errors: ScanError[] = [];
      let filesExamined = 0;

      if (languagesPresent.has('csharp')) {
        const applicableCSharp = applicable.filter((f) => detectArchLanguage(f.path) === 'csharp');
        await hydrateHeadCSharpNamespaces(
          deps,
          applicableCSharp,
          resolveCtx,
          removedFiles,
          headContentCache,
          probeBudget,
          counters,
        );
      }

      for (const file of applicable) {
        if (deps.signal.aborted) break;
        try {
          const normPath = normalizePath(file.path);
          const content =
            headContentCache.get(normPath) ?? (await readHeadFileContent(deps, file, counters));
          filesExamined += 1;

          await probeHeadAliasTargets(
            deps,
            file.path,
            content,
            file.added_lines,
            resolveCtx,
            probeCache,
            probeBudget,
            counters,
          );
          await probeHeadKotlinSymbols(
            deps,
            file.path,
            content,
            file.added_lines,
            resolveCtx,
            indexedKotlinFiles,
            probeBudget,
            counters,
          );

          const violations = evaluateFileArchitecture({
            filePath: file.path,
            content,
            spec,
            resolveCtx,
            onlyLines: file.added_lines,
          });

          for (const v of violations) {
            const finding: ScanFinding = {
              scanner: SCANNER_ID,
              rule_id: v.rule_id,
              file_path: v.file_path,
              line: v.line,
              severity: v.severity,
              category: 'architecture',
              title: v.title,
              description: v.description,
              confidence: 'high',
              evidence: {
                kind: 'architecture',
                rule: v.rule_id,
                specifier: v.specifier,
                ...(v.source_layer ? { source_layer: v.source_layer } : {}),
                ...(v.target_layer ? { target_layer: v.target_layer } : {}),
                ...(v.source_context ? { source_context: v.source_context } : {}),
                ...(v.target_context ? { target_context: v.target_context } : {}),
              },
              fingerprint: v.fingerprint,
            };

            const match = deps.ignoreList.matches(finding);
            if (!match.ignored) {
              findings.push(finding);
            } else if (match.expired) {
              void log.notice(expiredIgnoreNotice('architecture', finding, match));
            }
          }
        } catch (err) {
          void log.warn(`architecture: failed scanning ${file.path}: ${(err as Error).message}`);
          errors.push({
            message: `Architecture scan failed on ${file.path}`,
            cause: (err as Error).message,
            fatal: false,
          });
        }
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: {
          duration_ms: Date.now() - started,
          files_examined: filesExamined,
          network_calls: counters.networkCalls,
          cache_hits: counters.cacheHits,
        },
      };
    },
  };
}
