/**
 * Wraps `parse-diff` and converts its output into our domain `ChangedFile[]`,
 * with `reviewable_lines` and language/generated/binary classification computed.
 */

import parseDiff from 'parse-diff';
import type { ChangedFile } from '../types.js';
import { computeReviewableLines } from './reviewable-lines.js';

const GENERATED_PATTERNS = [
  /\.lock$/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /poetry\.lock$/,
  /Cargo\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /^dist\//,
  /^build\//,
  /^vendor\//,
  /node_modules\//,
  /__generated__\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /_pb2\.py$/,
];

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
  tf: 'terraform',
  hcl: 'hcl',
  dockerfile: 'dockerfile',
};

function detectLanguage(path: string): string {
  const name = path.split('/').pop() ?? '';
  if (/^Dockerfile/i.test(name)) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? 'plain';
}

function isGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

function determineStatus(file: parseDiff.File): ChangedFile['status'] {
  if (file.deleted) return 'removed';
  if (file.new) return 'added';
  if (file.from && file.to && file.from !== file.to) return 'renamed';
  return 'modified';
}

/**
 * Parse a unified diff string into our domain `ChangedFile[]`.
 *
 * Note: parse-diff returns binary files with empty `chunks`. We mark those
 * `is_binary: true` so the validator can reject comments on them with a useful
 * hint. (A more reliable signal would be the GitHub Files API which exposes
 * a `patch` field of `null` for binaries; we layer that in pr-context.ts.)
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files = parseDiff(diff);

  return files.map((file): ChangedFile => {
    const path = file.to && file.to !== '/dev/null' ? file.to : (file.from ?? '');
    const previousPath = file.from && file.from !== file.to ? file.from : undefined;
    const reviewable = computeReviewableLines(file.chunks);
    const totalChanges = file.chunks.reduce(
      (sum, c) => sum + c.changes.length,
      0,
    );

    return {
      path,
      ...(previousPath ? { previous_path: previousPath } : {}),
      status: determineStatus(file),
      additions: file.additions,
      deletions: file.deletions,
      reviewable_lines: reviewable.ranges,
      added_lines: reviewable.addedSet,
      language: detectLanguage(path),
      is_generated: isGenerated(path),
      is_binary: file.chunks.length === 0 && totalChanges === 0,
      size_bytes: 0, // Filled in by pr-context.ts via the Files API
      head_line_text: reviewable.text,
    };
  });
}
