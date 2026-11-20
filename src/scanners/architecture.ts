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

import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { evaluateFileArchitecture } from '../architecture/evaluator.js';
import { isTestFile, matchesAnyGlob, normalizePath } from '../architecture/glob.js';
import {
  detectArchLanguage,
  loadWorkspaceResolveContext,
  parseGoModModule,
  parsePubspecName,
  parseTsConfigContent,
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
  return lines.join('\n');
}

async function readHeadFileContent(deps: ScannerDeps, file: ChangedFile): Promise<string> {
  try {
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

async function readMetadataFile(deps: ScannerDeps, path: string): Promise<string | null> {
  try {
    return await deps.fileReader.read({
      owner: deps.owner,
      repo: deps.repo,
      path,
      ref: deps.head_sha,
    });
  } catch {
    return null; // optional project metadata file
  }
}

async function hydrateTsConfigFromHead(
  deps: ScannerDeps,
  headRaw: string,
): Promise<ReturnType<typeof parseTsConfigContent>> {
  const preloaded = new Map<string, string | null>();

  // Pre-fetch up to two relative `extends` hops from PR HEAD (with local
  // workspace fallback) so synchronous `parseTsConfigContent` resolves aliases
  // from the reviewed commit rather than an older checkout.
  const queue: Array<{ raw: string; dir: string; depth: number }> = [
    { raw: headRaw, dir: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= 2) continue;
    const extMatch = /"extends"\s*:\s*"([^"]+)"/.exec(item.raw);
    const extPath = extMatch?.[1];
    if (!extPath || (!extPath.startsWith('./') && !extPath.startsWith('../'))) continue;
    const joined = normalizePath(item.dir ? posix.join(item.dir, extPath) : extPath);
    if (!joined || preloaded.has(joined)) continue;
    let extRaw = await readMetadataFile(deps, joined);
    if (extRaw === null && deps.workspaceDir) {
      try {
        extRaw = readFileSync(resolve(deps.workspaceDir, joined), 'utf-8');
      } catch {
        extRaw = null; // extended tsconfig missing both remotely and locally
      }
    }
    preloaded.set(joined, extRaw);
    if (extRaw) {
      queue.push({ raw: extRaw, dir: posix.dirname(joined), depth: item.depth + 1 });
    }
  }

  return parseTsConfigContent(headRaw, (relPath) => {
    const norm = normalizePath(relPath);
    if (preloaded.has(norm)) return preloaded.get(norm) ?? null;
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

async function hydrateResolveContext(
  deps: ScannerDeps,
  languagesPresent: ReadonlySet<ArchLanguage>,
): Promise<WorkspaceResolveContext> {
  const ctx = loadWorkspaceResolveContext(deps.workspaceDir);

  if (languagesPresent.has('typescript') || languagesPresent.has('javascript')) {
    const raw = await readMetadataFile(deps, 'tsconfig.json');
    if (raw !== null) {
      const parsed = await hydrateTsConfigFromHead(deps, raw);
      if (parsed) ctx.tsconfig = parsed;
      else delete ctx.tsconfig;
    }
  }

  if (languagesPresent.has('go')) {
    const raw = await readMetadataFile(deps, 'go.mod');
    if (raw !== null) {
      const goModule = parseGoModModule(raw);
      if (goModule) ctx.goModule = goModule;
      else delete ctx.goModule;
    }
  }

  if (languagesPresent.has('dart')) {
    const raw = await readMetadataFile(deps, 'pubspec.yaml');
    if (raw !== null) {
      const dartPkg = parsePubspecName(raw);
      if (dartPkg) ctx.dartPackage = dartPkg;
      else delete ctx.dartPackage;
    }
  }

  return ctx;
}

function isFileApplicable(file: ChangedFile, spec: ResolvedArchitectureSpec): boolean {
  if (file.status === 'removed' || file.is_binary || file.is_generated) return false;
  if (detectArchLanguage(file.path) === null) return false;
  if (spec.ignore_tests && isTestFile(file.path)) return false;
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

      const resolveCtx = await hydrateResolveContext(deps, languagesPresent);
      const findings: ScanFinding[] = [];
      const errors: ScanError[] = [];
      let filesExamined = 0;

      for (const file of applicable) {
        if (deps.signal.aborted) break;
        try {
          const content = await readHeadFileContent(deps, file);
          filesExamined += 1;

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
          network_calls: 0,
          cache_hits: 0,
        },
      };
    },
  };
}
