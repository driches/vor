/**
 * Read a planted case from disk into an in-memory representation that the
 * orchestrator adapter can feed to runOrchestrator.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
  const caseDir = join(goldenRepo, 'cases', caseId);
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
  // We don't validate every TruthEntry field shape here — downstream scoring
  // tolerates partial shapes via fallback semantics. Top-level array shape is
  // the load-bearing invariant.
  const truths = rawTruths as TruthEntry[];

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
    const st = statSync(p);
    if (st.isDirectory()) walk(p, onFile);
    else if (st.isFile()) onFile(p);
  }
}
