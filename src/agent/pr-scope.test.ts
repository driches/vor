import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { PRContext } from '../github/pr-context.js';
import type { ChangedFile } from '../types.js';
import { buildAgentScopeNotice, scopePrContextForAgent } from './pr-scope.js';

function makeFile(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: 2,
    deletions: 1,
    reviewable_lines: [[1, 2]],
    added_lines: new Set([1, 2]),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 3,
    head_line_text: new Map(),
    ...over,
  };
}

function makeContext(files: ChangedFile[]): PRContext {
  return {
    metadata: {
      number: 1,
      title: 'Test',
      body: '',
      author: 'tester',
      base_sha: 'b'.repeat(40),
      head_sha: 'h'.repeat(40),
      base_ref: 'main',
      head_ref: 'feature',
      labels: [],
      changed_file_count: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      draft: false,
    },
    files,
    diff: files
      .map(
        (f) =>
          `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`,
      )
      .join(''),
  };
}

describe('scopePrContextForAgent', () => {
  it('removes configured excluded paths from the agent files and diff', () => {
    const context = makeContext([
      makeFile('src/review-me.ts'),
      makeFile('package-lock.json'),
      makeFile('dist/bundle.js'),
    ]);

    const scoped = scopePrContextForAgent(context, DEFAULT_CONFIG.exclude);

    expect(scoped.prContext.files.map((f) => f.path)).toEqual(['src/review-me.ts']);
    expect(scoped.unreviewedPaths).toEqual(['package-lock.json', 'dist/bundle.js']);
    expect(scoped.prContext.diff).toContain('src/review-me.ts');
    expect(scoped.prContext.diff).not.toContain('package-lock.json');
    expect(scoped.prContext.diff).not.toContain('dist/bundle.js');
  });

  it('removes files over max_diff_lines_per_file', () => {
    const context = makeContext([
      makeFile('src/small.ts', { additions: 3, deletions: 1 }),
      makeFile('src/huge.ts', { additions: 100, deletions: 1 }),
    ]);

    const scoped = scopePrContextForAgent(context, {
      paths: [],
      max_diff_lines_per_file: 50,
    });

    expect(scoped.prContext.files.map((f) => f.path)).toEqual(['src/small.ts']);
    expect(scoped.unreviewedPaths).toEqual(['src/huge.ts']);
  });

  it('matches root files with ** patterns', () => {
    const context = makeContext([makeFile('yarn.lock'), makeFile('src/app.ts')]);

    const scoped = scopePrContextForAgent(context, {
      paths: ['**/*.lock'],
      max_diff_lines_per_file: 1000,
    });

    expect(scoped.unreviewedPaths).toEqual(['yarn.lock']);
    expect(scoped.prContext.files.map((f) => f.path)).toEqual(['src/app.ts']);
  });
});

describe('buildAgentScopeNotice', () => {
  it('renders an empty string when nothing was scoped out', () => {
    expect(buildAgentScopeNotice([])).toBe('');
  });

  it('renders skipped paths and scanner caveat', () => {
    const out = buildAgentScopeNotice(['package-lock.json']);
    expect(out).toContain('package-lock.json');
    expect(out).toContain('Deterministic scanners may still inspect them');
  });
});
