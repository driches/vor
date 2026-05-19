import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff-parser.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixtures = resolve(__dirname, '../../tests/fixtures/diffs');

function load(name: string): string {
  return readFileSync(resolve(fixtures, name), 'utf-8');
}

describe('parseUnifiedDiff', () => {
  it('parses a simple single-file diff', () => {
    const files = parseUnifiedDiff(load('simple-add.patch'));
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/foo.ts');
    expect(f.status).toBe('modified');
    expect(f.language).toBe('typescript');
    expect(f.is_generated).toBe(false);
    expect(f.is_binary).toBe(false);
    // Reviewable should include all added lines on RIGHT side
    expect(f.reviewable_lines.length).toBeGreaterThan(0);
  });

  it('detects generated files', () => {
    const files = parseUnifiedDiff(load('multi-file.patch'));
    const pkg = files.find((f) => f.path === 'package.json');
    expect(pkg).toBeDefined();
    // package.json itself isn't auto-classified as generated, but lockfiles are
    expect(pkg!.is_generated).toBe(false);
  });

  it('handles multiple hunks in one file', () => {
    const files = parseUnifiedDiff(load('multi-hunk.patch'));
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('src/util.ts');
    // Two hunks → two separate ranges
    expect(f.reviewable_lines.length).toBeGreaterThanOrEqual(2);
  });

  it('detects added files (new mode)', () => {
    const files = parseUnifiedDiff(load('multi-file.patch'));
    const idx = files.find((f) => f.path === 'src/index.ts');
    expect(idx).toBeDefined();
    expect(idx!.status).toBe('added');
  });

  it('detects deleted files', () => {
    const files = parseUnifiedDiff(load('multi-file.patch'));
    const old = files.find((f) => f.path === 'src/old.ts' || f.previous_path === 'src/old.ts');
    expect(old).toBeDefined();
    expect(old!.status).toBe('removed');
  });

  it('records additions and deletions counts', () => {
    const files = parseUnifiedDiff(load('simple-add.patch'));
    const f = files[0]!;
    expect(f.additions).toBeGreaterThan(0);
    expect(f.deletions).toBeGreaterThan(0);
  });

  it('detects programming language from extension', () => {
    expect(parseUnifiedDiff(load('multi-hunk.patch'))[0]!.language).toBe('typescript');
  });

  it('records head_line_text for added lines', () => {
    const files = parseUnifiedDiff(load('simple-add.patch'));
    const f = files[0]!;
    // Some line should have text content
    expect(f.head_line_text.size).toBeGreaterThan(0);
  });

  it('returns empty array for empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
