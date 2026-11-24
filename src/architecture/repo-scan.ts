/**
 * Whole-repository deterministic architecture check (`vor arch check` and MCP
 * `check_architecture`) plus single-file diagnostic explanation (`vor arch explain`).
 *
 * Zero LLM calls. Reuses the exact same evaluator, import resolver, and
 * ignore-list semantics used on PR reviews.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expiredIgnoreNotice, IgnoreList } from '../scanners/ignore-list.js';
import type { ScanFinding } from '../scanners/types.js';
import { SEVERITY_RANK, type Severity } from '../types.js';
import { ConfigError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { classifyLayer, evaluateFileArchitecture, type ArchViolation } from './evaluator.js';
import {
  extractContext,
  isTestFile,
  matchesAnyGlob,
  normalizePath,
  type ContextMatch,
} from './glob.js';
import {
  buildCSharpNamespaceMap,
  detectArchLanguage,
  extractCSharpNamespace,
  extractImports,
  extractKotlinDeclarations,
  loadWorkspaceResolveContext,
  resolveImports,
  type ArchLanguage,
} from './imports.js';
import { DEFAULT_BASELINE_FILE, isSafeRelativePath, loadArchBaseline } from './loader.js';
import type { ResolvedArchitectureSpec } from './presets.js';

const WALK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'vendor',
  'coverage',
  '__generated__',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
  '.dart_tool',
]);

export interface RepoArchCheckOptions {
  workspaceDir: string;
  spec: ResolvedArchitectureSpec;
  /** Repo-wide exclude globs (typically `.vor.yml` `exclude.paths`). */
  excludePaths?: readonly string[];
  /** Path to `.vor/security-ignore.yml` relative to workspace. */
  ignoreFilePath?: string;
  /** Path to baseline JSON file relative to workspace. */
  baselinePath?: string;
  useBaseline?: boolean;
  failOn?: Severity;
}

export interface RepoArchCheckResult {
  preset: ResolvedArchitectureSpec['preset'];
  files_scanned: number;
  layers_matched: number;
  contexts_matched: number;
  suppressed_by_ignore: number;
  suppressed_by_baseline: number;
  violations: ArchViolation[];
  /** Fingerprints of all non-ignore-list violations (including baseline-suppressed ones; used for writing baselines). */
  all_fingerprints: string[];
  passed: boolean;
  fail_on: Severity;
  duration_ms: number;
}

export interface ExplainedImport {
  line: number;
  specifier: string;
  resolved_path?: string;
  package_name?: string;
  target_layer: string | null;
  target_context: string | null;
  violations: ArchViolation[];
}

export interface FileArchitectureExplanation {
  file_path: string;
  language: ArchLanguage | null;
  ignored_reason: 'test_file' | 'excluded' | 'unsupported_language' | null;
  layer: {
    name: string;
    description?: string;
    can_import?: string[];
    cannot_import?: string[];
    forbid_packages?: string[];
    allow_packages?: string[];
  } | null;
  context: ContextMatch | null;
  imports: ExplainedImport[];
}

function enumerateRepoFiles(workspaceDir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .split('\0')
      .map((p) => normalizePath(p))
      .filter(Boolean);
  } catch {
    // Non-git directory fallback: walk filesystem directly while pruning heavy build dirs.
    const files: string[] = [];
    const walk = (dir: string, relBase: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable or vanished directory during walk
      }
      for (const entry of entries) {
        // Cargo binary targets live in `src/bin/` (and `<crate>/src/bin/`),
        // which are source files rather than compiled `bin/` output folders.
        const isCargoBinDir =
          entry.name === 'bin' && (relBase === 'src' || relBase.endsWith('/src'));
        if (WALK_SKIP_DIRS.has(entry.name) && !isCargoBinDir) continue;
        // Skip symlinks before isDirectory()/isFile() so circular directory
        // links cannot cause infinite recursion or escape workspaceDir.
        if (entry.isSymbolicLink()) continue;
        const abs = join(dir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile()) {
          files.push(normalizePath(rel));
        }
      }
    };
    walk(workspaceDir, '');
    return files;
  }
}

function loadLocalIgnoreList(workspaceDir: string, ignoreFilePath: string): IgnoreList {
  if (!isSafeRelativePath(workspaceDir, ignoreFilePath)) {
    return IgnoreList.empty();
  }
  try {
    const raw = readFileSync(resolve(workspaceDir, ignoreFilePath), 'utf-8');
    return IgnoreList.fromString(raw, ignoreFilePath);
  } catch {
    return IgnoreList.empty(); // missing ignore file means no suppressions
  }
}

function violationToIgnoreProbe(v: ArchViolation): ScanFinding {
  return {
    scanner: 'architecture',
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
}

const MAX_SYMBOL_INDEX_FILES = 2000;
const MAX_INDEX_FILE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 10_000;

function scanPartitionedRepoFiles(
  workspaceDir: string,
  repoFiles: Iterable<string>,
  extRe: RegExp,
  onFile: (normRelPath: string, content: string) => void,
): void {
  const prodFiles: string[] = [];
  const testFiles: string[] = [];
  for (const f of repoFiles) {
    if (!extRe.test(f)) continue;
    if (isTestFile(f)) testFiles.push(f);
    else prodFiles.push(f);
  }
  prodFiles.sort();
  testFiles.sort();

  const root = resolve(workspaceDir);
  let scanned = 0;
  for (const list of [prodFiles, testFiles]) {
    for (const relPath of list) {
      if (scanned >= MAX_SYMBOL_INDEX_FILES) return;
      const absPath = resolve(root, relPath);
      let content: string;
      try {
        const st = lstatSync(absPath);
        if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_INDEX_FILE_BYTES) continue;
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue; // missing, unreadable, or non-regular file
      }
      scanned += 1;
      onFile(normalizePath(relPath), content);
    }
  }
}

function buildCSharpNamespaceIndex(
  workspaceDir: string,
  repoFiles: Iterable<string>,
): Map<string, string> {
  const fileNamespaces = new Map<string, string>();
  scanPartitionedRepoFiles(workspaceDir, repoFiles, /\.cs$/i, (normPath, content) => {
    const ns = extractCSharpNamespace(content);
    if (ns) fileNamespaces.set(normPath, ns);
  });
  return buildCSharpNamespaceMap(fileNamespaces);
}

function buildKotlinSymbolIndex(
  workspaceDir: string,
  repoFiles: Iterable<string>,
): Map<string, string> {
  const index = new Map<string, string>();
  scanPartitionedRepoFiles(workspaceDir, repoFiles, /\.(?:kt|kts)$/i, (normPath, content) => {
    const decl = extractKotlinDeclarations(content);
    if (!decl.packageName) return;
    for (const sym of decl.symbols) {
      const fqn = `${decl.packageName}.${sym}`;
      // Sorted prodFiles run before testFiles, so production declarations win deterministically.
      if (!index.has(fqn)) {
        index.set(fqn, normPath);
      }
    }
  });
  return index;
}

export async function runRepoArchitectureCheck(
  opts: RepoArchCheckOptions,
): Promise<RepoArchCheckResult> {
  const started = Date.now();
  const failOn: Severity = opts.failOn ?? 'minor';
  const allRepoFiles = enumerateRepoFiles(opts.workspaceDir);
  const knownFiles = new Set(allRepoFiles);
  const resolveCtx = loadWorkspaceResolveContext(opts.workspaceDir, { knownFiles });

  const excludePaths = opts.excludePaths ?? [];
  let hasScannableCSharp = false;
  let hasScannableKotlin = false;
  for (const filePath of allRepoFiles) {
    const lang = detectArchLanguage(filePath);
    if (lang !== 'csharp' && lang !== 'kotlin') continue;
    if (matchesAnyGlob(filePath, excludePaths) || matchesAnyGlob(filePath, opts.spec.exclude)) {
      continue;
    }
    if (opts.spec.ignore_tests && isTestFile(filePath)) continue;
    if (lang === 'csharp') hasScannableCSharp = true;
    else hasScannableKotlin = true;
    if (hasScannableCSharp && hasScannableKotlin) break;
  }
  // Build cross-file symbol indexes up front (each bounded by MAX_SYMBOL_INDEX_FILES
  // and MAX_INDEX_FILE_BYTES) before the main MAX_SCAN_FILES evaluation pass so
  // namespace/package imports can resolve accurately against symbol declarations.
  if (hasScannableCSharp) {
    resolveCtx.csharpNamespaces = buildCSharpNamespaceIndex(opts.workspaceDir, allRepoFiles);
  }
  if (hasScannableKotlin) {
    resolveCtx.kotlinSymbols = buildKotlinSymbolIndex(opts.workspaceDir, allRepoFiles);
  }

  const ignoreList = loadLocalIgnoreList(
    opts.workspaceDir,
    opts.ignoreFilePath ?? '.vor/security-ignore.yml',
  );
  const baselinePath = opts.baselinePath ?? opts.spec.baseline_file ?? DEFAULT_BASELINE_FILE;
  const baseline =
    opts.useBaseline === false
      ? new Set<string>()
      : loadArchBaseline(opts.workspaceDir, baselinePath);

  let filesScanned = 0;
  let layersMatched = 0;
  let contextsMatched = 0;
  let suppressedByIgnore = 0;
  let suppressedByBaseline = 0;

  const violations: ArchViolation[] = [];
  const allFingerprints: string[] = [];

  for (const filePath of allRepoFiles) {
    if (detectArchLanguage(filePath) === null) continue;
    if (matchesAnyGlob(filePath, excludePaths)) continue;
    if (matchesAnyGlob(filePath, opts.spec.exclude)) continue;
    if (opts.spec.ignore_tests && isTestFile(filePath)) continue;

    let content: string;
    try {
      const absPath = resolve(opts.workspaceDir, filePath);
      const st = lstatSync(absPath);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_INDEX_FILE_BYTES) continue;
      if (filesScanned >= MAX_SCAN_FILES) {
        void logger.warn(
          `Architecture scan capped at ${MAX_SCAN_FILES} scanned source files; narrow spec.exclude or root to scan remaining files.`,
        );
        break;
      }
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue; // deleted or unreadable symlink in dirty working tree
    }

    filesScanned += 1;
    if (classifyLayer(filePath, opts.spec)) layersMatched += 1;
    if (opts.spec.contexts && extractContext(filePath, opts.spec.contexts.pattern)) {
      contextsMatched += 1;
    }

    const fileViolations = evaluateFileArchitecture({
      filePath,
      content,
      spec: opts.spec,
      resolveCtx,
    });

    for (const v of fileViolations) {
      const probe = violationToIgnoreProbe(v);
      const ignoreMatch = ignoreList.matches(probe);
      if (ignoreMatch.ignored) {
        suppressedByIgnore += 1;
        if (ignoreMatch.expired) {
          void logger.notice(expiredIgnoreNotice('architecture', probe, ignoreMatch));
        }
        continue;
      }

      allFingerprints.push(v.fingerprint);

      if (baseline.has(v.fingerprint)) {
        suppressedByBaseline += 1;
        continue;
      }

      violations.push(v);
    }
  }

  violations.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    const pathDiff = a.file_path.localeCompare(b.file_path);
    if (pathDiff !== 0) return pathDiff;
    return a.line - b.line;
  });

  const passed = !violations.some((v) => SEVERITY_RANK[v.severity] >= SEVERITY_RANK[failOn]);

  return {
    preset: opts.spec.preset,
    files_scanned: filesScanned,
    layers_matched: layersMatched,
    contexts_matched: contextsMatched,
    suppressed_by_ignore: suppressedByIgnore,
    suppressed_by_baseline: suppressedByBaseline,
    violations,
    all_fingerprints: allFingerprints,
    passed,
    fail_on: failOn,
    duration_ms: Date.now() - started,
  };
}

export function explainFileArchitecture(
  workspaceDir: string,
  filePath: string,
  spec: ResolvedArchitectureSpec,
  excludePaths: readonly string[] = [],
  knownFiles?: ReadonlySet<string>,
): FileArchitectureExplanation {
  const root = resolve(workspaceDir);
  const rawRel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  if (!isSafeRelativePath(workspaceDir, rawRel)) {
    throw new ConfigError(`File path '${filePath}' escapes workspace root.`);
  }
  const relPath = normalizePath(rawRel);

  const language = detectArchLanguage(relPath);
  const layerMatch = classifyLayer(relPath, spec);
  const contextMatch = spec.contexts ? extractContext(relPath, spec.contexts.pattern) : null;

  let ignoredReason: FileArchitectureExplanation['ignored_reason'] = null;
  if (language === null) ignoredReason = 'unsupported_language';
  else if (spec.ignore_tests && isTestFile(relPath)) ignoredReason = 'test_file';
  else if (matchesAnyGlob(relPath, excludePaths) || matchesAnyGlob(relPath, spec.exclude)) {
    ignoredReason = 'excluded';
  }

  const layerSummary = layerMatch
    ? {
        name: layerMatch.name,
        ...(layerMatch.def.description ? { description: layerMatch.def.description } : {}),
        ...(layerMatch.def.can_import ? { can_import: layerMatch.def.can_import } : {}),
        ...(layerMatch.def.cannot_import ? { cannot_import: layerMatch.def.cannot_import } : {}),
        ...(layerMatch.def.forbid_packages
          ? { forbid_packages: layerMatch.def.forbid_packages }
          : {}),
        ...(layerMatch.def.allow_packages ? { allow_packages: layerMatch.def.allow_packages } : {}),
      }
    : null;

  if (language === null) {
    return {
      file_path: relPath,
      language,
      ignored_reason: ignoredReason,
      layer: layerSummary,
      context: contextMatch,
      imports: [],
    };
  }

  const resolvedKnownFiles = knownFiles ?? new Set(enumerateRepoFiles(workspaceDir));
  const resolveCtx = loadWorkspaceResolveContext(workspaceDir, { knownFiles: resolvedKnownFiles });
  if (language === 'csharp') {
    resolveCtx.csharpNamespaces = buildCSharpNamespaceIndex(workspaceDir, resolvedKnownFiles);
  } else if (language === 'kotlin') {
    resolveCtx.kotlinSymbols = buildKotlinSymbolIndex(workspaceDir, resolvedKnownFiles);
  }
  let content: string;
  try {
    content = readFileSync(resolve(root, relPath), 'utf-8');
  } catch (err) {
    throw new ConfigError(
      `Cannot read file '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { imports, meta } = extractImports(relPath, content);
  const allViolations = evaluateFileArchitecture({
    filePath: relPath,
    content,
    spec: { ...spec, ignore_tests: false, exclude: [] },
    resolveCtx,
  });

  const explainedImports: ExplainedImport[] = resolveImports(
    imports,
    relPath,
    resolveCtx,
    meta,
  ).map((resolved) => {
    const targetLayer = resolved.resolvedPath
      ? (classifyLayer(resolved.resolvedPath, spec)?.name ?? null)
      : null;
    const targetContext =
      spec.contexts && resolved.resolvedPath
        ? (extractContext(resolved.resolvedPath, spec.contexts.pattern)?.context ?? null)
        : null;
    const lineViolations = allViolations.filter(
      (v) => v.line === resolved.line && v.specifier === resolved.specifier,
    );
    return {
      line: resolved.line,
      specifier: resolved.specifier,
      ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath } : {}),
      ...(resolved.packageName ? { package_name: resolved.packageName } : {}),
      target_layer: targetLayer,
      target_context: targetContext,
      violations: lineViolations,
    };
  });

  return {
    file_path: relPath,
    language,
    ignored_reason: ignoredReason,
    layer: layerSummary,
    context: contextMatch,
    imports: explainedImports,
  };
}
