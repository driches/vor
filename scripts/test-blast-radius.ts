#!/usr/bin/env node
/**
 * Smoke test for the blast-radius pre-pass. Runs against the actual vor repo
 * using the real changed files from this branch, and prints the rendered block
 * that would appear in the agent's user prompt.
 *
 * Usage:
 *   npx tsx scripts/test-blast-radius.ts [--base origin/main]
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBlastRadius } from '../src/context/blast-radius.js';
import { renderBlastRadius } from '../src/agent/user-prompt.js';
import type { ChangedFile } from '../src/types.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function inferLanguage(path: string): string {
  if (/\.[mc]?[jt]sx?$/.test(path)) return 'typescript';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.go')) return 'go';
  return 'unknown';
}

function parseDiffIntoChangedFiles(base: string): ChangedFile[] {
  const rawDiff = git(['diff', '--unified=3', `${base}..HEAD`]);
  const files: ChangedFile[] = [];

  let currentPath = '';
  let currentAdded: number[] = [];
  let currentLines: Map<number, string> = new Map();
  let headLineNo = 0;

  function flush() {
    if (!currentPath) return;
    const added = new Set(currentAdded);
    files.push({
      path: currentPath,
      status: 'modified',
      additions: currentAdded.length,
      deletions: 0,
      reviewable_lines: currentAdded.length > 0 ? [[currentAdded[0]!, currentAdded.at(-1)!]] : [],
      added_lines: added,
      language: inferLanguage(currentPath),
      is_generated: false,
      is_binary: false,
      size_bytes: 0,
      head_line_text: currentLines,
    });
  }

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = '';
      currentAdded = [];
      currentLines = new Map();
      headLineNo = 0;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice(6);
      continue;
    }
    if (line.startsWith('@@ ')) {
      // @@ -old,count +new,start @@
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (m) headLineNo = Number.parseInt(m[1]!, 10) - 1;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('index ') || line.startsWith('\\')) continue;
    if (line.startsWith('-')) continue; // deleted line, no head line number
    if (line.startsWith('+')) {
      headLineNo++;
      currentAdded.push(headLineNo);
      currentLines.set(headLineNo, line.slice(1));
      continue;
    }
    // context line
    if (line.length > 0) {
      headLineNo++;
      currentLines.set(headLineNo, line.slice(1));
    }
  }
  flush();
  return files.filter((f) => f.additions > 0);
}

async function main() {
  const base = process.argv.includes('--base')
    ? process.argv[process.argv.indexOf('--base') + 1]!
    : 'origin/main';

  console.log(`\nBlast-radius smoke test`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Diff: ${base}..HEAD\n`);

  const changedFiles = parseDiffIntoChangedFiles(base);
  console.log(`Changed files with additions: ${changedFiles.map((f) => f.path).join(', ')}\n`);

  const map = await computeBlastRadius({
    changedFiles,
    workspaceDir: repoRoot,
    maxSymbols: 30,
    maxRefsPerSymbol: 8,
  });

  console.log(`--- computeBlastRadius result ---`);
  console.log(`entries: ${map.entries.length}, truncated: ${map.truncated}`);
  for (const e of map.entries) {
    console.log(`\n  symbol: ${e.symbol}`);
    console.log(`  defined_in: ${e.defined_in}`);
    console.log(`  reference_count: ${e.reference_count}`);
    for (const r of e.referenced_by) {
      console.log(`    ${r.path}:${r.line}  ${r.excerpt.slice(0, 80)}`);
    }
  }

  const rendered = renderBlastRadius(map);
  if (rendered) {
    console.log(`\n--- Rendered prompt block (what the agent sees) ---\n`);
    console.log(rendered);
  } else {
    console.log('\n(No blast-radius block — map is empty)');
  }
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
