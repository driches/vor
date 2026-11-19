/**
 * Converts a unified diff into the platform-neutral changed-file contract.
 */

import parseDiff from 'parse-diff';
import type { ChangedFile } from '../types.js';
import { computeReviewableLines } from './reviewable-lines.js';

const GENERATED_PATTERNS = [
  /\.lock$/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /go\.sum$/,
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

export function detectLanguage(path: string): string {
  const name = path.split('/').pop() ?? '';
  if (/^Dockerfile/i.test(name)) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? 'plain';
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

function determineStatus(file: parseDiff.File): ChangedFile['status'] {
  if (file.deleted) return 'removed';
  if (file.new) return 'added';
  if (file.from && file.to && file.from !== file.to) return 'renamed';
  return 'modified';
}

export function parseUnifiedDiff(diff: string): ChangedFile[] {
  return parseDiff(diff).map((file): ChangedFile => {
    const path = file.to && file.to !== '/dev/null' ? file.to : (file.from ?? '');
    const previousPath = file.from && file.from !== file.to ? file.from : undefined;
    const reviewable = computeReviewableLines(file.chunks);
    const totalChanges = file.chunks.reduce((sum, chunk) => sum + chunk.changes.length, 0);

    return {
      path,
      ...(previousPath ? { previous_path: previousPath } : {}),
      status: determineStatus(file),
      additions: file.additions,
      deletions: file.deletions,
      reviewable_lines: reviewable.ranges,
      added_lines: reviewable.addedSet,
      language: detectLanguage(path),
      is_generated: isGeneratedPath(path),
      is_binary: file.chunks.length === 0 && totalChanges === 0,
      size_bytes: 0,
      head_line_text: reviewable.text,
    };
  });
}
