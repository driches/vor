/**
 * Read a planted case from disk into an in-memory representation that the
 * orchestrator adapter can feed to runOrchestrator.
 */
import { lstatSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveCaseDir } from '../plant/case-paths.js';
import type { TruthEntry } from './types.js';

export interface LoadedFile {
  path: string;     // relative to after/ (or before/)
  content: string;
}

export interface LoadedCase {
  case_id: string;
  files: LoadedFile[];        // after/ contents
  beforeFiles: LoadedFile[];  // before/ contents — used by the adapter to synthesize a real diff
  truths: TruthEntry[];
}

export function loadCase(goldenRepo: string, caseId: string): LoadedCase {
  // Same lexical + symlink guard the planter uses, so `--case ../other-repo/case`
  // (or a symlinked alias pointing outside the golden tree) can't make loadCase
  // read after/, before/, and truth.yml from arbitrary locations. See PR #10
  // Codex P2 3295138893.
  const caseDir = resolveCaseDir(goldenRepo, caseId);
  const afterDir = join(caseDir, 'after');
  if (!existsSync(afterDir)) {
    throw new Error(`Case ${caseId} not found at ${afterDir}`);
  }
  const beforeDir = join(caseDir, 'before');
  if (!existsSync(beforeDir)) {
    throw new Error(`Case ${caseId} is missing before/ snapshot`);
  }
  const truthPath = join(caseDir, 'truth.yml');
  if (!existsSync(truthPath)) {
    throw new Error(
      `Case ${caseId} has no truth.yml — has it been planted? Run golden:plant --case ${caseId}`,
    );
  }
  const truthYaml = readFileSync(truthPath, 'utf-8');
  // Validate strictly: a malformed truth.yml (missing top-level `truths:` or
  // wrong shape) would silently yield zero truths and `scoreRun` would then
  // report recall=1.0 on the malformed case. Fail loud instead.
  const parsed = parseYaml(truthYaml) as unknown;
  if (parsed == null || typeof parsed !== 'object' || !('truths' in parsed)) {
    throw new Error(
      `Case ${caseId}: truth.yml is malformed — expected top-level 'truths:' array, got ${JSON.stringify(parsed)}`,
    );
  }
  const rawTruths = (parsed as { truths: unknown }).truths;
  if (!Array.isArray(rawTruths)) {
    throw new Error(
      `Case ${caseId}: truth.yml 'truths' field must be an array, got ${typeof rawTruths}`,
    );
  }
  // Validate every entry shape before downstream scoring touches it.
  // scoreRun destructures `truth.line_range` and calls `truth.category.includes(...)`
  // — a malformed entry (missing category, non-tuple line_range, etc.) would
  // crash scoring at runtime with an obscure TypeError instead of a clear
  // dataset error. Fail loud at load. See PR #10 Codex P2 3295049301.
  const truths: TruthEntry[] = rawTruths.map((raw, i) => validateTruthEntry(raw, caseId, i));

  const files: LoadedFile[] = [];
  walk(afterDir, (path) => {
    files.push({
      path: relative(afterDir, path).replaceAll('\\', '/'),
      content: readFileSync(path, 'utf-8'),
    });
  });

  const beforeFiles: LoadedFile[] = [];
  walk(beforeDir, (path) => {
    beforeFiles.push({
      path: relative(beforeDir, path).replaceAll('\\', '/'),
      content: readFileSync(path, 'utf-8'),
    });
  });

  return { case_id: caseId, files, beforeFiles, truths };
}

const SEVERITY_VALUES = new Set(['critical', 'important', 'minor', 'nit']);

function validateTruthEntry(raw: unknown, caseId: string, index: number): TruthEntry {
  const where = `Case ${caseId}: truth.yml entry [${index}]`;
  if (raw == null || typeof raw !== 'object') {
    throw new Error(`${where} must be an object, got ${typeof raw}`);
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.file !== 'string' || entry.file.length === 0) {
    throw new Error(`${where} missing required string field 'file'`);
  }
  if (
    !Array.isArray(entry.line_range) ||
    entry.line_range.length !== 2 ||
    typeof entry.line_range[0] !== 'number' ||
    typeof entry.line_range[1] !== 'number'
  ) {
    throw new Error(
      `${where} 'line_range' must be a [start, end] number tuple, got ${JSON.stringify(entry.line_range)}`,
    );
  }
  const [rangeStart, rangeEnd] = entry.line_range as [number, number];
  // Require ordered 1-based positive integers. scoreRun applies line-slack
  // matching against this range and assumes start <= end; malformed ranges
  // like [0, 0], floats, or reversed ranges ([20, 10]) would silently
  // produce spurious TP/FN/FP outcomes instead of failing fast as dataset
  // corruption. See PR #10 Codex P2 3295092576.
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
    throw new Error(
      `${where} 'line_range' values must be integers (1-based line numbers), got [${rangeStart}, ${rangeEnd}]`,
    );
  }
  if (rangeStart < 1 || rangeEnd < 1) {
    throw new Error(
      `${where} 'line_range' values must be >= 1 (1-based line numbers), got [${rangeStart}, ${rangeEnd}]`,
    );
  }
  if (rangeStart > rangeEnd) {
    throw new Error(
      `${where} 'line_range' must be ordered [start, end] with start <= end, got [${rangeStart}, ${rangeEnd}]`,
    );
  }
  if (typeof entry.bug_type !== 'string' || entry.bug_type.length === 0) {
    throw new Error(`${where} missing required string field 'bug_type'`);
  }
  if (typeof entry.severity !== 'string' || !SEVERITY_VALUES.has(entry.severity)) {
    throw new Error(
      `${where} 'severity' must be one of critical|important|minor|nit, got ${JSON.stringify(entry.severity)}`,
    );
  }
  if (typeof entry.plant_id !== 'number') {
    throw new Error(`${where} missing required number field 'plant_id'`);
  }
  if (
    !Array.isArray(entry.category) ||
    entry.category.length === 0 ||
    !entry.category.every((c) => typeof c === 'string')
  ) {
    throw new Error(
      `${where} 'category' must be a non-empty array of category strings, got ${JSON.stringify(entry.category)}`,
    );
  }
  // We deliberately don't validate that each category string is in the
  // Category union — scoreRun's `truth.category.includes(finding.category)`
  // tolerates unknown categories (they just never match). Strictness here
  // would refuse forward-compatible truth files that name future categories.
  return entry as unknown as TruthEntry;
}

function walk(dir: string, onFile: (p: string) => void): void {
  // Sort lexicographically so multi-file cases produce a deterministic file
  // order across runs and machines. Raw `readdirSync` order is
  // filesystem-dependent (e.g. ext4 returns insertion order, APFS/HFS+
  // return name order). Without sorting, the adapter's synthesized diff and
  // pulls.listFiles output would vary between runs, introducing eval
  // variance unrelated to model quality. See PR #10 Codex P2 3295006721.
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const p = join(dir, entry);
    // Use lstatSync (does NOT follow symlinks) and refuse symlink entries.
    // statSync follows symlinks, so a symlinked directory inside before/ or
    // after/ would pull external files into LoadedCase.files[]/beforeFiles[],
    // and a cycle like `loop -> ..` would recurse indefinitely. Same threat
    // model as the planter's copyTree (Fix V). See PR #10 Codex P2 3295138894.
    const lst = lstatSync(p);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `case-loader: refusing to traverse symlink ${p} — eval cases must be ` +
          `self-contained regular-file trees. Replace the symlink with a real file/directory.`,
      );
    }
    const st = statSync(p);
    if (st.isDirectory()) walk(p, onFile);
    else if (st.isFile()) onFile(p);
  }
}
