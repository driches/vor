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
  const parsed = parseYaml(truthYaml) as { truths?: TruthEntry[] } | null;
  const truths = parsed?.truths ?? [];

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
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, onFile);
    else if (st.isFile()) onFile(p);
  }
}
