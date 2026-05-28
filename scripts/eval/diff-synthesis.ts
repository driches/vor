/**
 * Pure diff synthesis for synthetic eval cases. Lives in its own module so it
 * can be imported from contexts (CLIs, scripts) that don't run under vitest —
 * `orchestrator-adapter.ts` uses `vi.mock` at module scope, which throws when
 * the module is imported outside the vitest runtime.
 *
 * The function takes a LoadedCase (before/ + after/ snapshots) and produces a
 * realistic unified diff plus the per-file `listFiles`-shaped API entries the
 * orchestrator's PR-context fetcher expects.
 */

import { createPatch } from 'diff';
import type { LoadedCase } from './case-loader.js';

export interface SynthesizedFileEntry {
  filename: string;
  changes: number;
  patch: string | null | undefined;
}

export interface SynthesizedDiff {
  diff: string;
  filesApi: SynthesizedFileEntry[];
}

export function synthesizeDiff(c: LoadedCase): SynthesizedDiff {
  // Compute a REAL unified diff between before/ and after/ snapshots. Only the
  // lines that were actually planted (or otherwise changed) appear as added.
  // Pre-existing content in before/ stays out of the diff, so the secrets and
  // CVE scanners don't see it as a "+" line and don't bias precision/recall.
  const beforeByPath = new Map(c.beforeFiles.map((f) => [f.path, f.content]));
  const afterByPath = new Map(c.files.map((f) => [f.path, f.content]));
  // `.vor.yml` is adapter-internal (we inject it for config plumbing);
  // it must not appear in the diff or the orchestrator will try to review it.
  beforeByPath.delete('.vor.yml');
  afterByPath.delete('.vor.yml');

  // Sort merged paths so the synthesized diff is fully lexicographic. Set
  // preserves insertion order; we sort to keep ordering deterministic across
  // before/after splits.
  const allPaths = [
    ...new Set<string>([...beforeByPath.keys(), ...afterByPath.keys()]),
  ].sort();
  const chunks: string[] = [];
  const filesApi: SynthesizedFileEntry[] = [];
  for (const path of allPaths) {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);
    if (before === after) continue;
    if (before === undefined) {
      const fileDiff = renderNewFile(path, after ?? '');
      if (fileDiff == null) continue;
      chunks.push(fileDiff.diff);
      filesApi.push({ filename: path, changes: fileDiff.addedLines, patch: fileDiff.diff });
      continue;
    }
    if (after === undefined) {
      const fileDiff = renderDeletedFile(path, before);
      if (fileDiff == null) continue;
      chunks.push(fileDiff.diff);
      filesApi.push({ filename: path, changes: fileDiff.deletedLines, patch: fileDiff.diff });
      continue;
    }
    const fileDiff = renderModifiedFile(path, before, after);
    if (fileDiff == null) continue;
    chunks.push(fileDiff.diff);
    filesApi.push({
      filename: path,
      changes: fileDiff.addedLines + fileDiff.deletedLines,
      patch: fileDiff.diff,
    });
  }
  return { diff: chunks.length > 0 ? chunks.join('\n') + '\n' : '', filesApi };
}

function splitBodyLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function renderNewFile(
  path: string,
  content: string,
): { diff: string; addedLines: number } | null {
  const lines = splitBodyLines(content);
  if (lines.length === 0) return null;
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('new file mode 100644');
  out.push('index 0000000..1111111');
  out.push('--- /dev/null');
  out.push(`+++ b/${path}`);
  out.push(`@@ -0,0 +1,${lines.length} @@`);
  for (const ln of lines) out.push('+' + ln);
  return { diff: out.join('\n'), addedLines: lines.length };
}

function renderDeletedFile(
  path: string,
  content: string,
): { diff: string; deletedLines: number } | null {
  const lines = splitBodyLines(content);
  if (lines.length === 0) return null;
  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('deleted file mode 100644');
  out.push('index 1111111..0000000');
  out.push(`--- a/${path}`);
  out.push('+++ /dev/null');
  out.push(`@@ -1,${lines.length} +0,0 @@`);
  for (const ln of lines) out.push('-' + ln);
  return { diff: out.join('\n'), deletedLines: lines.length };
}

function renderModifiedFile(
  path: string,
  before: string,
  after: string,
): { diff: string; addedLines: number; deletedLines: number } | null {
  const patch = createPatch(path, before, after, '', '', { context: 3 });
  const patchLines = patch.split('\n');
  if (patchLines.length > 0 && patchLines[patchLines.length - 1] === '') {
    patchLines.pop();
  }
  let idx = 0;
  while (idx < patchLines.length && !patchLines[idx]!.startsWith('--- ')) idx += 1;
  if (idx >= patchLines.length) return null;
  let hasHunk = false;
  for (let i = idx; i < patchLines.length; i++) {
    if (patchLines[i]!.startsWith('@@')) {
      hasHunk = true;
      break;
    }
  }
  if (!hasHunk) return null;

  const out: string[] = [];
  out.push(`diff --git a/${path} b/${path}`);
  out.push('index 0000000..1111111 100644');
  out.push(`--- a/${path}`);
  out.push(`+++ b/${path}`);
  let addedLines = 0;
  let deletedLines = 0;
  for (let i = idx + 2; i < patchLines.length; i++) {
    const ln = patchLines[i]!;
    out.push(ln);
    if (ln.startsWith('+') && !ln.startsWith('+++')) addedLines += 1;
    else if (ln.startsWith('-') && !ln.startsWith('---')) deletedLines += 1;
  }
  return { diff: out.join('\n'), addedLines, deletedLines };
}
