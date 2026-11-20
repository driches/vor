import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { resolveArchitectureSpec } from '../architecture/presets.js';
import type { ChangedFile } from '../types.js';
import { InMemoryScanCache } from './cache.js';
import { IgnoreList } from './ignore-list.js';
import { createArchitectureScanner } from './architecture.js';
import type { ScannerDeps } from './types.js';

function makeChangedFile(path: string, lines: Record<number, string>): ChangedFile {
  const lineEntries = Object.entries(lines).map(([k, v]) => [Number(k), v] as const);
  const addedSet = new Set(lineEntries.map(([k]) => k));
  const maxLine = Math.max(1, ...addedSet);
  return {
    path,
    status: 'modified',
    additions: addedSet.size,
    deletions: 0,
    reviewable_lines: [[1, maxLine]],
    added_lines: addedSet,
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 200,
    head_line_text: new Map(lineEntries),
  };
}

function makeDeps(files: ChangedFile[], fileContents: Record<string, string>): ScannerDeps {
  return {
    octokit: {} as ScannerDeps['octokit'],
    owner: 'acme',
    repo: 'app',
    pull_number: 1,
    head_sha: 'abc123',
    changedFiles: files,
    contextFiles: [],
    diff: '',
    workspaceDir: '',
    cache: new InMemoryScanCache(),
    ignoreList: IgnoreList.empty(),
    fileReader: {
      read: vi.fn(async ({ path }: { path: string }) => fileContents[path] ?? null),
    } as unknown as ScannerDeps['fileReader'],
    config: DEFAULT_CONFIG.security,
    signal: new AbortController().signal,
  };
}

describe('createArchitectureScanner', () => {
  it('flags added import violations and ignores untouched lines', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'hexagonal',
    });
    const scanner = createArchitectureScanner(spec);
    const filePath = 'src/domain/order.ts';
    const content = [
      "import { OldRepo } from '../adapters/out/old_repo';",
      "import { NewRepo } from '../adapters/out/new_repo';",
      'export const ok = 1;',
    ].join('\n');

    const changed = makeChangedFile(filePath, {
      2: "import { NewRepo } from '../adapters/out/new_repo';",
    });

    expect(scanner.applies([changed])).toBe(true);
    const result = await scanner.scan(makeDeps([changed], { [filePath]: content }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(2);
    expect(result.findings[0]?.category).toBe('architecture');
    expect(result.findings[0]?.rule_id).toBe('arch:layer:domain-to-adapters_out');
  });

  it('skips when deterministic_enforcement is false', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'hexagonal',
      deterministic_enforcement: false,
    });
    const scanner = createArchitectureScanner(spec);
    const changed = makeChangedFile('src/domain/order.ts', { 1: "import 'express';" });
    expect(scanner.applies([changed])).toBe(false);
  });

  it('honors ignoreList suppressions on architecture findings', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'hexagonal',
    });
    const scanner = createArchitectureScanner(spec);
    const filePath = 'src/domain/order.ts';
    const content = "import express from 'express';\n";
    const changed = makeChangedFile(filePath, { 1: "import express from 'express';" });
    const deps = makeDeps([changed], { [filePath]: content });
    deps.ignoreList = IgnoreList.fromString(`
entries:
  - file: src/domain/order.ts
    rule: "arch:forbidden-package:domain"
    reason: Temporary exception
`);

    const result = await scanner.scan(deps);
    expect(result.findings).toEqual([]);
  });

  it('prefers PR HEAD tsconfig.json over stale workspace checkout tsconfig.json', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-head-meta-'));
    try {
      // Old checkout lacks the `@infra/*` path alias.
      writeFileSync(
        join(ws, 'tsconfig.json'),
        '{"compilerOptions":{"baseUrl":".","paths":{"@domain/*":["src/domain/*"]}}}',
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });
      const scanner = createArchitectureScanner(spec);
      const filePath = 'src/domain/order.ts';
      const content = "import { Repo } from '@infra/pg';\nexport const r = Repo;\n";
      const changed = makeChangedFile(filePath, {
        1: "import { Repo } from '@infra/pg';",
      });
      const headTsConfig =
        '{"compilerOptions":{"baseUrl":".","paths":{"@infra/*":["src/infrastructure/*"]}}}';

      const deps = makeDeps([changed], {
        [filePath]: content,
        'tsconfig.json': headTsConfig,
      });
      deps.workspaceDir = ws;

      const result = await scanner.scan(deps);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('hydrates and rebases extended tsconfig baseUrl and paths from PR HEAD', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src',
    });
    const scanner = createArchitectureScanner(spec);
    const filePath = 'src/domain/order.ts';
    const content = "import { Repo } from '@infra/pg';\nexport const r = Repo;\n";
    const changed = makeChangedFile(filePath, {
      1: "import { Repo } from '@infra/pg';",
    });

    const deps = makeDeps([changed], {
      [filePath]: content,
      'tsconfig.json': JSON.stringify({ extends: './config/base.json' }),
      'config/base.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: {
            '@infra/*': ['src/infrastructure/*'],
          },
        },
      }),
    });

    const result = await scanner.scan(deps);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
  });
});
