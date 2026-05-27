/**
 * Tests for the migration-safety scanner — risky DDL (DROP/TRUNCATE, NOT NULL
 * without default) on PR-added lines of migration files.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile, LineRange } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createMigrationSafetyScanner } from './migration-safety.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'migrations/001_init.sql',
    status: 'added',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'sql',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

function makeFileWithLines(
  path_: string,
  lines: readonly string[],
  over: Partial<ChangedFile> = {},
): ChangedFile {
  const text = new Map<number, string>();
  const added = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    text.set(i + 1, lines[i]!);
    added.add(i + 1);
  }
  const ranges: LineRange[] = lines.length > 0 ? [[1, lines.length]] : [];
  return makeChangedFile({
    path: path_,
    head_line_text: text,
    reviewable_lines: ranges,
    added_lines: added,
    ...over,
  });
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
}

function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    octokit: {} as Octokit,
    owner: 'o',
    repo: 'r',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: [],
    contextFiles: [],
    diff: '',
    workspaceDir: '/tmp',
    cache: new InMemoryScanCache(),
    ignoreList: makeIgnoreList(),
    fileReader: { read: vi.fn().mockResolvedValue(null) } as unknown as FileReader,
    config: {} as unknown as SecurityConfig,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('createMigrationSafetyScanner — applies()', () => {
  it('matches .sql files and migration directories', () => {
    const s = createMigrationSafetyScanner();
    expect(s.applies([makeChangedFile({ path: 'db/schema.sql' })])).toBe(true);
    expect(s.applies([makeChangedFile({ path: 'db/migrate/20240101_x.rb' })])).toBe(true);
    expect(s.applies([makeChangedFile({ path: 'prisma/migrations/x/migration.sql' })])).toBe(true);
  });

  it('does not match ordinary source files', () => {
    expect(createMigrationSafetyScanner().applies([makeChangedFile({ path: 'src/app.ts' })])).toBe(
      false,
    );
  });
});

describe('createMigrationSafetyScanner — scan()', () => {
  it('flags DROP TABLE as critical data-loss', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('migrations/2.sql', ['DROP TABLE users;'])],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.rule_id).toBe('migration:drop-table');
    expect(result.findings[0]!.severity).toBe('critical');
    expect(result.findings[0]!.category).toBe('data-loss');
  });

  it('flags DROP COLUMN', async () => {
    const deps = makeScannerDeps({
      changedFiles: [
        makeFileWithLines('migrations/3.sql', ['ALTER TABLE users DROP COLUMN email;']),
      ],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain('migration:drop-column');
  });

  it('flags TRUNCATE', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('migrations/4.sql', ['TRUNCATE TABLE sessions;'])],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain('migration:truncate');
  });

  it('flags ADD COLUMN NOT NULL without a DEFAULT', async () => {
    const deps = makeScannerDeps({
      changedFiles: [
        makeFileWithLines('migrations/5.sql', ['ALTER TABLE users ADD COLUMN age int NOT NULL;']),
      ],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings.map((f) => f.rule_id)).toContain(
      'migration:add-not-null-without-default',
    );
  });

  it('does NOT flag NOT NULL when a DEFAULT is present on the same line', async () => {
    const deps = makeScannerDeps({
      changedFiles: [
        makeFileWithLines('migrations/6.sql', [
          'ALTER TABLE users ADD COLUMN age int NOT NULL DEFAULT 0;',
        ]),
      ],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });

  it('only scans added lines, not context', async () => {
    const file = makeChangedFile({
      path: 'migrations/7.sql',
      head_line_text: new Map([[3, 'DROP TABLE users;']]),
      reviewable_lines: [[3, 3]],
      added_lines: new Set(),
    });
    const result = await createMigrationSafetyScanner().scan(
      makeScannerDeps({ changedFiles: [file] }),
    );
    expect(result.findings).toHaveLength(0);
  });

  it('does not scan non-migration files', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('src/app.ts', ['DROP TABLE users;'])],
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });

  it('suppresses findings matched by the ignore-list', async () => {
    const deps = makeScannerDeps({
      changedFiles: [makeFileWithLines('migrations/8.sql', ['DROP TABLE users;'])],
      ignoreList: makeIgnoreList({ ignored: true }),
    });
    const result = await createMigrationSafetyScanner().scan(deps);
    expect(result.findings).toHaveLength(0);
  });
});
