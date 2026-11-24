import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/infrastructure/pg.ts'), 'export const pg = 1;\n');
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

  it('resolves tsconfig alias targets existing only at PR HEAD via HEAD tree or fileReader fallback', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-stale-checkout-'));
    try {
      // Stale checkout has tsconfig.json defining `@infra/*`, but lacks unchanged `src/infrastructure/repo.ts`.
      const tsConfigJson =
        '{"compilerOptions":{"baseUrl":".","paths":{"@infra/*":["src/infrastructure/*"]}}}';
      writeFileSync(join(ws, 'tsconfig.json'), tsConfigJson);
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });
      const scanner = createArchitectureScanner(spec);
      const domainFile = 'src/domain/order.ts';
      const domainContent = [
        "import { Repo } from '@infra/repo';",
        "import { MissingPkg } from '@infra/missing';",
        'export const r = [Repo, MissingPkg];',
      ].join('\n');
      const changed = makeChangedFile(domainFile, {
        1: "import { Repo } from '@infra/repo';",
        2: "import { MissingPkg } from '@infra/missing';",
      });

      // Case 1: octokit.rest.git.getTree supplies the PR HEAD tree (no need to read unchanged repo.ts).
      const treeDeps = makeDeps([changed], {
        [domainFile]: domainContent,
        'tsconfig.json': tsConfigJson,
      });
      treeDeps.workspaceDir = ws;
      treeDeps.octokit = {
        rest: {
          git: {
            getTree: vi.fn(async () => ({
              data: {
                truncated: false,
                tree: [
                  { type: 'blob', path: domainFile },
                  { type: 'blob', path: 'tsconfig.json' },
                  { type: 'blob', path: 'src/infrastructure/repo.ts' },
                ],
              },
            })),
          },
        },
      } as unknown as ScannerDeps['octokit'];

      const treeResult = await scanner.scan(treeDeps);
      expect(treeResult.findings).toHaveLength(1);
      expect(treeResult.findings[0]?.line).toBe(1);
      expect(treeResult.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
      expect(treeResult.metrics.network_calls).toBeGreaterThan(0);

      // Case 2: git.getTree is unavailable/truncated; probeHeadAliasTargets checks fileReader at HEAD.
      const fallbackDeps = makeDeps([changed], {
        [domainFile]: domainContent,
        'tsconfig.json': tsConfigJson,
        'src/infrastructure/repo.ts': 'export const Repo = 1;\n',
      });
      fallbackDeps.workspaceDir = ws;

      const fallbackResult = await scanner.scan(fallbackDeps);
      expect(fallbackResult.findings).toHaveLength(1);
      expect(fallbackResult.findings[0]?.line).toBe(1);
      expect(fallbackResult.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
      expect(fallbackResult.metrics.network_calls).toBeGreaterThan(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('probes Kotlin symbol declarations on PR HEAD for modular-monolith public API checks', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'modular-monolith',
      root: 'src/main/kotlin/com/acme',
    });
    const scanner = createArchitectureScanner(spec);
    const billingPath = 'src/main/kotlin/com/acme/modules/billing/BillingService.kt';
    const billingContent = [
      'package com.acme.modules.billing',
      'import com.acme.modules.orders.placeOrder',
      'import com.acme.modules.orders.secretHelper',
      'class BillingService',
    ].join('\n');

    const changed = makeChangedFile(billingPath, {
      2: 'import com.acme.modules.orders.placeOrder',
      3: 'import com.acme.modules.orders.secretHelper',
    });
    const deps = makeDeps([changed], {
      [billingPath]: billingContent,
      'src/main/kotlin/com/acme/modules/orders/index.kt':
        'package com.acme.modules.orders\nfun placeOrder(): String = "ok"\n',
      'src/main/kotlin/com/acme/modules/orders/Internal.kt':
        'package com.acme.modules.orders\nfun secretHelper(): String = "secret"\n',
    });
    deps.octokit = {
      rest: {
        git: {
          getTree: vi.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: 'blob', path: billingPath },
                { type: 'blob', path: 'src/main/kotlin/com/acme/modules/orders/index.kt' },
                { type: 'blob', path: 'src/main/kotlin/com/acme/modules/orders/Internal.kt' },
              ],
            },
          })),
        },
      },
    } as unknown as ScannerDeps['octokit'];

    const res = await scanner.scan(deps);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.line).toBe(3);
    expect(res.findings[0]?.rule_id).toBe('arch:context-boundary');
    expect(res.metrics.network_calls).toBeGreaterThan(0);
  });

  it('clears stale checkout tsconfig/go.mod/pubspec metadata when confirmed absent at PR HEAD, while keeping fallback on API error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-deleted-meta-'));
    try {
      // Base checkout contains stale metadata files and the target infra file.
      writeFileSync(
        join(ws, 'tsconfig.json'),
        '{"compilerOptions":{"baseUrl":".","paths":{"@infra/*":["src/infrastructure/*"]}}}',
      );
      writeFileSync(join(ws, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
      writeFileSync(join(ws, 'pubspec.yaml'), 'name: my_app\n');
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/infrastructure/repo.ts'), 'export const Repo = 1;\n');
      mkdirSync(join(ws, 'internal/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'internal/infrastructure/store.go'), 'package infrastructure\n');
      mkdirSync(join(ws, 'lib/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'lib/infrastructure/db.dart'), 'class Db {}\n');

      const tsDomain = 'src/domain/order.ts';
      const tsContent = "import { Repo } from '@infra/repo';\nexport const x = Repo;\n";
      const tsChanged = makeChangedFile(tsDomain, { 1: "import { Repo } from '@infra/repo';" });

      const tsSpec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });
      const tsScanner = createArchitectureScanner(tsSpec);

      // Case 1a: tsconfig.json deleted in PR HEAD -> fileReader.read returns null.
      const tsAbsentDeps = makeDeps([tsChanged], {
        [tsDomain]: tsContent,
      });
      tsAbsentDeps.workspaceDir = ws;
      const tsAbsentRes = await tsScanner.scan(tsAbsentDeps);
      expect(tsAbsentRes.findings).toEqual([]);

      // Case 1b: tsconfig.json omitted from untruncated HEAD tree -> confirmed absent without using checkout.
      const tsTreeAbsentDeps = makeDeps([tsChanged], {
        [tsDomain]: tsContent,
      });
      tsTreeAbsentDeps.workspaceDir = ws;
      tsTreeAbsentDeps.octokit = {
        rest: {
          git: {
            getTree: vi.fn(async () => ({
              data: {
                truncated: false,
                tree: [
                  { type: 'blob', path: tsDomain },
                  { type: 'blob', path: 'src/infrastructure/repo.ts' },
                ],
              },
            })),
          },
        },
      } as unknown as ScannerDeps['octokit'];
      const tsTreeAbsentRes = await tsScanner.scan(tsTreeAbsentDeps);
      expect(tsTreeAbsentRes.findings).toEqual([]);

      // Case 2: go.mod and pubspec.yaml absent at PR HEAD -> treated as external packages, not internal layers.
      const goDomain = 'internal/domain/service.go';
      const goContent = 'package domain\nimport "example.com/app/internal/infrastructure/store"\n';
      const goChanged = makeChangedFile(goDomain, {
        2: 'import "example.com/app/internal/infrastructure/store"',
      });
      const goSpec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'internal',
      });
      const goAbsentDeps = makeDeps([goChanged], { [goDomain]: goContent });
      goAbsentDeps.workspaceDir = ws;
      expect((await createArchitectureScanner(goSpec).scan(goAbsentDeps)).findings).toEqual([]);

      const dartDomain = 'lib/domain/entity.dart';
      const dartContent = "import 'package:my_app/infrastructure/db.dart';\n";
      const dartChanged = makeChangedFile(dartDomain, {
        1: "import 'package:my_app/infrastructure/db.dart';",
      });
      const dartSpec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'lib',
      });
      const dartAbsentDeps = makeDeps([dartChanged], { [dartDomain]: dartContent });
      dartAbsentDeps.workspaceDir = ws;
      expect((await createArchitectureScanner(dartSpec).scan(dartAbsentDeps)).findings).toEqual([]);

      // Case 3: transient API error reading tsconfig.json retains checkout tsconfig fallback.
      const tsErrorDeps = makeDeps([tsChanged], { [tsDomain]: tsContent });
      tsErrorDeps.workspaceDir = ws;
      tsErrorDeps.fileReader = {
        read: vi.fn(async ({ path }: { path: string }) => {
          if (path === 'tsconfig.json') throw new Error('503 Service Unavailable');
          return path === tsDomain ? tsContent : null;
        }),
      } as unknown as ScannerDeps['fileReader'];
      const tsErrorRes = await tsScanner.scan(tsErrorDeps);
      expect(tsErrorRes.findings).toHaveLength(1);
      expect(tsErrorRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('populates C# namespace index from PR HEAD content when namespaces do not mirror directories', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src',
    });
    const scanner = createArchitectureScanner(spec);
    const domainPath = 'src/domain/Order.cs';
    const domainContent = [
      'using System;',
      'using Acme.Storage;',
      'namespace Acme.Orders;',
      'public class Order {}',
    ].join('\n');
    const infraPath = 'src/infrastructure/Repo.cs';
    const infraContent = 'namespace Acme.Storage;\npublic class Repo {}\n';

    const changed = makeChangedFile(domainPath, {
      2: 'using Acme.Storage;',
    });

    // Case 1: API-only review (empty workspaceDir) with complete HEAD inventory and readable files.
    const apiDeps = makeDeps([changed], {
      [domainPath]: domainContent,
      [infraPath]: infraContent,
    });
    apiDeps.octokit = {
      rest: {
        git: {
          getTree: vi.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: 'blob', path: domainPath },
                { type: 'blob', path: infraPath },
              ],
            },
          })),
        },
      },
    } as unknown as ScannerDeps['octokit'];

    const apiRes = await scanner.scan(apiDeps);
    expect(apiRes.findings).toHaveLength(1);
    expect(apiRes.findings[0]?.line).toBe(2);
    expect(apiRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');

    // Case 2: Stale local checkout where PR HEAD updates Repo.cs out of `Acme.Storage` -> no false positive.
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-cs-stale-'));
    try {
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, infraPath), infraContent);

      const movedChanged: ChangedFile = {
        path: infraPath,
        status: 'modified',
        additions: 1,
        deletions: 1,
        reviewable_lines: [[1, 2]],
        added_lines: new Set(),
        language: 'csharp',
        is_generated: false,
        is_binary: false,
        size_bytes: 50,
        head_line_text: new Map(),
      };
      const updatedInfraContent = 'namespace Acme.External;\npublic class Repo {}\n';
      const staleDeps = makeDeps([changed, movedChanged], {
        [domainPath]: domainContent,
        [infraPath]: updatedInfraContent,
      });
      staleDeps.workspaceDir = ws;

      const staleRes = await scanner.scan(staleDeps);
      expect(staleRes.findings).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('hydrates and respects deleted package-local tsconfig.json in monorepo PR scans', async () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'packages/app/src',
    });
    const scanner = createArchitectureScanner(spec);
    const domainPath = 'packages/app/src/domain/order.ts';
    const domainContent =
      "import { repo } from '@app/infrastructure/repo';\nexport const x = repo;\n";
    const infraPath = 'packages/app/src/infrastructure/repo.ts';
    const pkgTsConfigPath = 'packages/app/tsconfig.json';
    const pkgTsConfigContent = JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@app/*': ['src/*'] },
      },
    });

    const changedDomain = makeChangedFile(domainPath, { 1: domainContent.split('\n')[0]! });

    // Case 1: API-only review with no root tsconfig and no headTree -> probeHeadAliasTargets
    // resolves @app/* via packages/app/tsconfig.json and flags the layer violation.
    const apiDeps = makeDeps([changedDomain], {
      [domainPath]: domainContent,
      [pkgTsConfigPath]: pkgTsConfigContent,
      [infraPath]: 'export const repo = 1;\n',
    });
    const apiRes = await scanner.scan(apiDeps);
    expect(apiRes.findings).toHaveLength(1);
    expect(apiRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(apiRes.findings[0]?.line).toBe(1);

    // Case 1b: Same monorepo PR with Git tree inventory (headTree present).
    apiDeps.octokit = {
      rest: {
        git: {
          getTree: vi.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: 'blob', path: domainPath },
                { type: 'blob', path: pkgTsConfigPath },
                { type: 'blob', path: infraPath },
              ],
            },
          })),
        },
      },
    } as unknown as ScannerDeps['octokit'];
    const treeRes = await scanner.scan(apiDeps);
    expect(treeRes.findings).toHaveLength(1);
    expect(treeRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');

    // Case 2: PR HEAD removes packages/app/tsconfig.json while stale local checkout still has it ->
    // confirmed deletion skips disk fallback so @app/* stays external.
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-pkg-ts-deleted-'));
    try {
      mkdirSync(join(ws, 'packages/app/src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, pkgTsConfigPath), pkgTsConfigContent);
      writeFileSync(join(ws, infraPath), 'export const repo = 1;\n');

      const removedTsConfig: ChangedFile = {
        path: pkgTsConfigPath,
        status: 'removed',
        additions: 0,
        deletions: 6,
        reviewable_lines: [],
        added_lines: new Set(),
        language: 'json',
        is_generated: false,
        is_binary: false,
        size_bytes: 90,
        head_line_text: new Map(),
      };
      const staleDeps = makeDeps([changedDomain, removedTsConfig], {
        [domainPath]: domainContent,
      });
      staleDeps.workspaceDir = ws;

      const staleRes = await scanner.scan(staleDeps);
      expect(staleRes.findings).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('hydrates nested go.mod from PR HEAD, respects deletions, and catches continued Python imports', async () => {
    const goSpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'services/orders',
    });
    const goScanner = createArchitectureScanner(goSpec);
    const goOrderPath = 'services/orders/domain/order.go';
    const goOrderContent = 'package domain\nimport "example.com/orders/infrastructure"\n';
    const goModPath = 'services/orders/go.mod';
    const goModContent = 'module example.com/orders\ngo 1.22\n';

    const changedGo = makeChangedFile(goOrderPath, {
      2: 'import "example.com/orders/infrastructure"',
    });
    changedGo.language = 'go';

    const apiGoDeps = makeDeps([changedGo], {
      [goOrderPath]: goOrderContent,
      [goModPath]: goModContent,
    });
    const goRes = await goScanner.scan(apiGoDeps);
    expect(goRes.findings).toHaveLength(1);
    expect(goRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(goRes.findings[0]?.line).toBe(2);

    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-go-mod-deleted-'));
    try {
      mkdirSync(join(ws, 'services/orders/infrastructure'), { recursive: true });
      writeFileSync(join(ws, goModPath), goModContent);
      const removedGoMod: ChangedFile = {
        path: goModPath,
        status: 'removed',
        additions: 0,
        deletions: 2,
        reviewable_lines: [],
        added_lines: new Set(),
        language: 'go',
        is_generated: false,
        is_binary: false,
        size_bytes: 32,
        head_line_text: new Map(),
      };
      const staleGoDeps = makeDeps([changedGo, removedGoMod], {
        [goOrderPath]: goOrderContent,
      });
      staleGoDeps.workspaceDir = ws;
      const staleGoRes = await goScanner.scan(staleGoDeps);
      expect(staleGoRes.findings).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }

    const pySpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'pyapp',
    });
    const pyScanner = createArchitectureScanner(pySpec);
    const pyPath = 'pyapp/domain/service.py';
    const pyContent = 'import os, \\\n    flask\n';
    const changedPy = makeChangedFile(pyPath, { 2: '    flask' });
    changedPy.language = 'python';
    const pyRes = await pyScanner.scan(makeDeps([changedPy], { [pyPath]: pyContent }));
    expect(pyRes.findings).toHaveLength(1);
    expect(pyRes.findings[0]?.rule_id).toBe('arch:forbidden-package:domain');
    expect(pyRes.findings[0]?.line).toBe(2);
  });

  it('resolves Cargo bin targets and hydrates Cargo.toml explicit paths from PR HEAD', async () => {
    const binSpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src/bin/worker',
    });
    const binScanner = createArchitectureScanner(binSpec);
    const workerDomainPath = 'src/bin/worker/domain/mod.rs';
    const workerDomainContent = 'use crate::infrastructure::Repo;\n';
    const changedWorker = makeChangedFile(workerDomainPath, {
      1: 'use crate::infrastructure::Repo;',
    });
    changedWorker.language = 'rust';

    const binRes = await binScanner.scan(
      makeDeps([changedWorker], {
        [workerDomainPath]: workerDomainContent,
        'src/lib.rs': 'pub fn shared() {}\n',
        'src/bin/worker/main.rs': 'mod domain;\nmod infrastructure;\n',
        'src/bin/worker/infrastructure/mod.rs': 'pub struct Repo;\n',
      }),
    );
    expect(binRes.findings).toHaveLength(1);
    expect(binRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(binRes.findings[0]?.line).toBe(1);

    const treeBinDeps = makeDeps([changedWorker], {
      [workerDomainPath]: workerDomainContent,
    });
    treeBinDeps.octokit = {
      rest: {
        git: {
          getTree: vi.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: 'blob', path: 'src/lib.rs' },
                { type: 'blob', path: 'src/bin/worker/main.rs' },
                { type: 'blob', path: workerDomainPath },
                { type: 'blob', path: 'src/bin/worker/infrastructure/mod.rs' },
              ],
            },
          })),
        },
      },
    } as unknown as ScannerDeps['octokit'];
    const treeBinRes = await binScanner.scan(treeBinDeps);
    expect(treeBinRes.findings).toHaveLength(1);
    expect(treeBinRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(treeBinRes.findings[0]?.line).toBe(1);

    const customSpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src/workers/job',
    });
    const customScanner = createArchitectureScanner(customSpec);
    const jobDomainPath = 'src/workers/job/domain/mod.rs';
    const changedJob = makeChangedFile(jobDomainPath, {
      1: 'use crate::infrastructure::Repo;',
    });
    changedJob.language = 'rust';

    const customRes = await customScanner.scan(
      makeDeps([changedJob], {
        'Cargo.toml':
          '[package]\nname = "demo"\n\n[[bin]]\nname = "job"\npath = "src/workers/job/entry.rs"\n',
        [jobDomainPath]: 'use crate::infrastructure::Repo;\n',
        'src/lib.rs': 'pub fn shared() {}\n',
        'src/workers/job/entry.rs': 'mod domain;\nmod infrastructure;\n',
        'src/workers/job/infrastructure/mod.rs': 'pub struct Repo;\n',
      }),
    );
    expect(customRes.findings).toHaveLength(1);
    expect(customRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(customRes.findings[0]?.line).toBe(1);

    const ownLibSpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src',
    });
    const ownLibScanner = createArchitectureScanner(ownLibSpec);
    const ownLibChanged = makeChangedFile(workerDomainPath, {
      1: 'use arch_sample::infrastructure::Repo;',
    });
    ownLibChanged.language = 'rust';

    // Case A: API-only PR scan without git.getTree probes src/lib.rs from PR HEAD.
    const ownLibApiRes = await ownLibScanner.scan(
      makeDeps([ownLibChanged], {
        'Cargo.toml': '[package]\nname = "arch_sample"\nversion = "0.1.0"\n',
        [workerDomainPath]: 'use arch_sample::infrastructure::Repo;\n',
        'src/lib.rs': 'pub mod infrastructure;\n',
        'src/bin/worker/main.rs': 'mod domain;\n',
        'src/infrastructure/mod.rs': 'pub struct Repo;\n',
      }),
    );
    expect(ownLibApiRes.findings).toHaveLength(1);
    expect(ownLibApiRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(ownLibApiRes.findings[0]?.line).toBe(1);

    // Case B: Full-tree PR scan with git.getTree resolves to src/infrastructure/mod.rs.
    const ownLibTreeDeps = makeDeps([ownLibChanged], {
      'Cargo.toml': '[package]\nname = "arch_sample"\nversion = "0.1.0"\n',
      [workerDomainPath]: 'use arch_sample::infrastructure::Repo;\n',
    });
    ownLibTreeDeps.octokit = {
      rest: {
        git: {
          getTree: vi.fn(async () => ({
            data: {
              truncated: false,
              tree: [
                { type: 'blob', path: 'Cargo.toml' },
                { type: 'blob', path: 'src/lib.rs' },
                { type: 'blob', path: 'src/infrastructure/mod.rs' },
                { type: 'blob', path: 'src/bin/worker/main.rs' },
                { type: 'blob', path: workerDomainPath },
              ],
            },
          })),
        },
      },
    } as unknown as ScannerDeps['octokit'];
    const ownLibTreeRes = await ownLibScanner.scan(ownLibTreeDeps);
    expect(ownLibTreeRes.findings).toHaveLength(1);
    expect(ownLibTreeRes.findings[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    expect(ownLibTreeRes.findings[0]?.line).toBe(1);
  });
});
