import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { ConfigError } from '../util/errors.js';
import { saveArchBaseline } from './loader.js';
import { resolveArchitectureSpec } from './presets.js';
import { explainFileArchitecture, runRepoArchitectureCheck } from './repo-scan.js';

function setupSampleHexRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-'));
  mkdirSync(join(ws, 'src/domain'), { recursive: true });
  mkdirSync(join(ws, 'src/ports'), { recursive: true });
  mkdirSync(join(ws, 'src/application'), { recursive: true });
  mkdirSync(join(ws, 'src/adapters/out'), { recursive: true });

  writeFileSync(
    join(ws, 'src/ports/order_repo.ts'),
    "import type { Order } from '../domain/order';\nexport interface OrderRepo { save(o: Order): Promise<void>; }\n",
  );
  writeFileSync(
    join(ws, 'src/application/place_order.ts'),
    "import { Order } from '../domain/order';\nimport type { OrderRepo } from '../ports/order_repo';\nexport const place = (r: OrderRepo, o: Order) => r.save(o);\n",
  );
  writeFileSync(
    join(ws, 'src/adapters/out/pg_order_repo.ts'),
    "import type { OrderRepo } from '../../ports/order_repo';\nexport const pgRepo: OrderRepo = { async save() {} };\n",
  );
  return ws;
}

describe('runRepoArchitectureCheck', () => {
  it('passes cleanly on compliant hexagonal repository', async () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(join(ws, 'src/domain/order.ts'), 'export interface Order { id: string }\n');
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const res = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(res.passed).toBe(true);
      expect(res.violations).toEqual([]);
      expect(res.files_scanned).toBe(4);
      expect(res.layers_matched).toBe(4);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('detects violations and supports baseline and ignore-file suppression', async () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });

      const failed = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(failed.passed).toBe(false);
      expect(failed.violations).toHaveLength(1);
      expect(failed.violations[0]?.rule_id).toBe('arch:layer:domain-to-adapters_out');

      // Baseline suppresses pre-existing violation
      saveArchBaseline(ws, '.vor/arch-baseline.json', failed.all_fingerprints);
      const baselined = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(baselined.passed).toBe(true);
      expect(baselined.suppressed_by_baseline).toBe(1);

      // Ignore file suppresses even when --no-baseline is passed
      mkdirSync(join(ws, '.vor'), { recursive: true });
      writeFileSync(
        join(ws, '.vor/security-ignore.yml'),
        `entries:\n  - file: src/domain/order.ts\n    rule: "arch:layer:domain-to-adapters_out"\n    reason: Legacy exception\n`,
      );
      const ignored = await runRepoArchitectureCheck({
        workspaceDir: ws,
        spec,
        useBaseline: false,
      });
      expect(ignored.passed).toBe(true);
      expect(ignored.suppressed_by_ignore).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('respects failOn threshold', async () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
        severity: 'minor',
      });
      const res = await runRepoArchitectureCheck({
        workspaceDir: ws,
        spec,
        failOn: 'important',
      });
      expect(res.violations).toHaveLength(1);
      expect(res.passed).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('skips circular directory symlinks during non-git fallback walk while reporting real violations', async () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      symlinkSync('..', join(ws, 'src/loop'), 'dir');

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const res = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(res.passed).toBe(false);
      expect(res.files_scanned).toBe(4);
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0]?.rule_id).toBe('arch:layer:domain-to-adapters_out');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('indexes C# namespaces across multi-file dotted project directories', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-cs-multi-'));
    try {
      mkdirSync(join(ws, 'src/Acme.Domain'), { recursive: true });
      mkdirSync(join(ws, 'src/Acme.Infrastructure'), { recursive: true });
      writeFileSync(
        join(ws, 'src/Acme.Domain/Order.cs'),
        'namespace Acme.Domain;\nusing Acme.Infrastructure;\npublic class Order {}\n',
      );
      writeFileSync(
        join(ws, 'src/Acme.Infrastructure/Repository.cs'),
        'namespace Acme.Infrastructure;\npublic class Repository {}\n',
      );
      writeFileSync(
        join(ws, 'src/Acme.Infrastructure/UnitOfWork.cs'),
        'namespace Acme.Infrastructure;\npublic class UnitOfWork {}\n',
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'custom',
        layers: {
          domain: {
            paths: ['src/Acme.Domain/**'],
            can_import: ['domain'],
          },
          infrastructure: {
            paths: ['src/Acme.Infrastructure/**'],
            can_import: ['domain', 'infrastructure'],
          },
        },
      });
      const res = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(res.passed).toBe(false);
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('explainFileArchitecture', () => {
  it('explains layer classification and per-import rule outcomes', () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const info = explainFileArchitecture(ws, 'src/domain/order.ts', spec);
      expect(info.layer?.name).toBe('domain');
      expect(info.imports).toHaveLength(1);
      expect(info.imports[0]?.target_layer).toBe('adapters_out');
      expect(info.imports[0]?.violations).toHaveLength(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace root', () => {
    const ws = setupSampleHexRepo();
    try {
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      expect(() => explainFileArchitecture(ws, '../outside.ts', spec)).toThrowError(ConfigError);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('accepts precomputed knownFiles without re-walking when resolving file imports', () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const knownFiles = new Set(['src/domain/order.ts', 'src/adapters/out/pg_order_repo.ts']);
      const info = explainFileArchitecture(ws, 'src/domain/order.ts', spec, [], knownFiles);
      expect(info.imports[0]?.resolved_path).toBe('src/adapters/out/pg_order_repo.ts');
      expect(info.imports[0]?.violations).toHaveLength(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('explains C# namespace imports resolved to repository layer paths', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-cs-'));
    try {
      mkdirSync(join(ws, 'src/Domain'), { recursive: true });
      mkdirSync(join(ws, 'src/Infrastructure'), { recursive: true });
      writeFileSync(
        join(ws, 'src/Domain/Order.cs'),
        'namespace Acme.Domain;\nusing Acme.Infrastructure;\npublic class Order {}\n',
      );
      writeFileSync(
        join(ws, 'src/Infrastructure/Repository.cs'),
        'namespace Acme.Infrastructure;\npublic class Repository {}\n',
      );
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'custom',
        layers: {
          domain: {
            paths: ['src/Domain/**'],
            can_import: ['domain'],
          },
          infrastructure: {
            paths: ['src/Infrastructure/**'],
            can_import: ['domain', 'infrastructure'],
          },
        },
      });
      const info = explainFileArchitecture(ws, 'src/Domain/Order.cs', spec);
      expect(info.layer?.name).toBe('domain');
      expect(info.imports).toHaveLength(1);
      expect(info.imports[0]?.resolved_path).toBe('src/Infrastructure');
      expect(info.imports[0]?.target_layer).toBe('infrastructure');
      expect(info.imports[0]?.violations).toHaveLength(1);
      expect(info.imports[0]?.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves Kotlin symbols to declaring files for modular-monolith public API checks', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-kt-'));
    try {
      mkdirSync(join(ws, 'src/main/kotlin/com/acme/modules/orders'), { recursive: true });
      mkdirSync(join(ws, 'src/main/kotlin/com/acme/modules/billing'), { recursive: true });
      writeFileSync(
        join(ws, 'src/main/kotlin/com/acme/modules/orders/index.kt'),
        'package com.acme.modules.orders\nfun placeOrder(): String = "ok"\n',
      );
      writeFileSync(
        join(ws, 'src/main/kotlin/com/acme/modules/orders/Internal.kt'),
        'package com.acme.modules.orders\nfun secretHelper(): String = "secret"\n',
      );
      writeFileSync(
        join(ws, 'src/main/kotlin/com/acme/modules/billing/BillingService.kt'),
        [
          'package com.acme.modules.billing',
          'import com.acme.modules.orders.placeOrder',
          'import com.acme.modules.orders.secretHelper',
          'class BillingService',
        ].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'modular-monolith',
        root: 'src/main/kotlin/com/acme',
      });

      const explained = explainFileArchitecture(
        ws,
        'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
        spec,
      );
      expect(explained.context?.context).toBe('billing');
      expect(explained.imports).toHaveLength(2);
      expect(explained.imports[0]?.resolved_path).toBe(
        'src/main/kotlin/com/acme/modules/orders/index.kt',
      );
      expect(explained.imports[0]?.violations).toEqual([]);
      expect(explained.imports[1]?.resolved_path).toBe(
        'src/main/kotlin/com/acme/modules/orders/Internal.kt',
      );
      expect(explained.imports[1]?.violations).toHaveLength(1);
      expect(explained.imports[1]?.violations[0]?.rule_id).toBe('arch:context-boundary');

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.rule_id).toBe('arch:context-boundary');
      expect(repoRes.violations[0]?.specifier).toBe('com.acme.modules.orders.secretHelper');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves cross-source-root Java imports to their owning module under modular-monolith', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-java-mm-'));
    try {
      mkdirSync(join(ws, 'modules/orders/src/main/java/com/acme/orders'), { recursive: true });
      mkdirSync(join(ws, 'modules/billing/src/main/java/com/acme/billing'), { recursive: true });
      writeFileSync(
        join(ws, 'modules/orders/src/main/java/com/acme/orders/Order.java'),
        'package com.acme.orders;\npublic class Order {}\n',
      );
      writeFileSync(
        join(ws, 'modules/billing/src/main/java/com/acme/billing/Service.java'),
        'package com.acme.billing;\nimport com.acme.orders.Order;\npublic class Service {}\n',
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'modular-monolith',
      });
      const explained = explainFileArchitecture(
        ws,
        'modules/billing/src/main/java/com/acme/billing/Service.java',
        spec,
      );
      expect(explained.context?.context).toBe('billing');
      expect(explained.imports).toHaveLength(1);
      expect(explained.imports[0]?.resolved_path).toBe(
        'modules/orders/src/main/java/com/acme/orders/Order.java',
      );
      expect(explained.imports[0]?.target_context).toBe('orders');
      expect(explained.imports[0]?.violations).toHaveLength(1);
      expect(explained.imports[0]?.violations[0]?.rule_id).toBe('arch:context-boundary');

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.rule_id).toBe('arch:context-boundary');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('throws ConfigError when explaining a missing or unreadable file', () => {
    const ws = setupSampleHexRepo();
    try {
      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      expect(() => explainFileArchitecture(ws, 'src/domain/missing.ts', spec)).toThrowError(
        ConfigError,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('exempts Go shared-kernel directory imports even under allow_dependencies: []', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-go-shared-'));
    try {
      mkdirSync(join(ws, 'contexts/orders'), { recursive: true });
      mkdirSync(join(ws, 'contexts/shared'), { recursive: true });
      writeFileSync(join(ws, 'go.mod'), 'module example.com/app\n');
      writeFileSync(join(ws, 'contexts/shared/money.go'), 'package shared\ntype Money struct{}\n');
      writeFileSync(
        join(ws, 'contexts/orders/order.go'),
        'package orders\nimport "example.com/app/contexts/shared"\nvar _ shared.Money\n',
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'custom',
        contexts: {
          pattern: 'contexts/*',
          shared: ['contexts/shared/**'],
          allow_dependencies: { orders: [] },
        },
      });

      const explained = explainFileArchitecture(ws, 'contexts/orders/order.go', spec);
      expect(explained.imports).toHaveLength(1);
      expect(explained.imports[0]?.resolved_path).toBe('contexts/shared');
      expect(explained.imports[0]?.violations).toEqual([]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(true);
      expect(repoRes.violations).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('skips oversized generated files above 512 KB while still evaluating normal source files', async () => {
    const ws = setupSampleHexRepo();
    try {
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { pgRepo } from '../adapters/out/pg_order_repo';\nexport const x = pgRepo;\n",
      );
      writeFileSync(
        join(ws, 'src/domain/huge_bundle.ts'),
        `import { pgRepo } from '../adapters/out/pg_order_repo';\n// ${'x'.repeat(600 * 1024)}\nexport const h = pgRepo;\n`,
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const res = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(res.passed).toBe(false);
      expect(res.files_scanned).toBe(4);
      expect(res.violations).toHaveLength(1);
      expect(res.violations[0]?.file_path).toBe('src/domain/order.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('enforces architecture rules using package-local tsconfig.json in monorepo workspaces', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-pkg-ts-'));
    try {
      mkdirSync(join(ws, 'packages/app/src/domain'), { recursive: true });
      mkdirSync(join(ws, 'packages/app/src/adapters/out'), { recursive: true });

      writeFileSync(
        join(ws, 'packages/app/tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@app/*': ['src/*'] },
          },
        }),
      );
      writeFileSync(join(ws, 'packages/app/src/adapters/out/repo.ts'), 'export const repo = 1;\n');
      writeFileSync(
        join(ws, 'packages/app/src/domain/order.ts'),
        "import { repo } from '@app/adapters/out/repo';\nexport const x = repo;\n",
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
        root: 'packages/app/src',
      });

      const explained = explainFileArchitecture(ws, 'packages/app/src/domain/order.ts', spec);
      expect(explained.imports[0]?.resolved_path).toBe('packages/app/src/adapters/out/repo.ts');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-adapters_out',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.file_path).toBe('packages/app/src/domain/order.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('enforces DDD rules via nested go.mod and multiline Python imports', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-go-py-'));
    try {
      mkdirSync(join(ws, 'services/orders/domain'), { recursive: true });
      mkdirSync(join(ws, 'services/orders/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'services/orders/go.mod'), 'module example.com/orders\ngo 1.22\n');
      writeFileSync(
        join(ws, 'services/orders/infrastructure/repo.go'),
        'package infrastructure\ntype Repo struct{}\n',
      );
      writeFileSync(
        join(ws, 'services/orders/domain/order.go'),
        'package domain\nimport "example.com/orders/infrastructure"\nvar _ infrastructure.Repo\n',
      );

      const goSpec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'services/orders',
      });
      const goExplained = explainFileArchitecture(ws, 'services/orders/domain/order.go', goSpec);
      expect(goExplained.imports[0]?.resolved_path).toBe('services/orders/infrastructure');
      expect(goExplained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const goRepoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec: goSpec });
      expect(goRepoRes.passed).toBe(false);
      expect(goRepoRes.violations.map((v) => v.file_path)).toContain(
        'services/orders/domain/order.go',
      );

      mkdirSync(join(ws, 'pyapp/domain'), { recursive: true });
      writeFileSync(join(ws, 'pyapp/domain/service.py'), 'import os, \\\n    flask\n');
      const pySpec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'pyapp',
      });
      const pyExplained = explainFileArchitecture(ws, 'pyapp/domain/service.py', pySpec);
      expect(pyExplained.imports.map((i) => ({ spec: i.specifier, line: i.line }))).toEqual([
        { spec: 'os', line: 1 },
        { spec: 'flask', line: 2 },
      ]);
      const flaskViolations = pyExplained.imports[1]?.violations ?? [];
      expect(flaskViolations).toHaveLength(1);
      expect(flaskViolations[0]?.rule_id).toBe('arch:forbidden-package:domain');
      expect(flaskViolations[0]?.line).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves inline Rust mod scopes accurately under DDD layer checks without false positives', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-rust-mod-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/lib.rs'), 'pub mod domain;\npub mod infrastructure;\n');
      writeFileSync(join(ws, 'src/infrastructure/mod.rs'), 'pub struct Repo;\n');
      writeFileSync(join(ws, 'src/domain/infrastructure.rs'), 'pub struct Repo;\n');
      writeFileSync(
        join(ws, 'src/domain/order.rs'),
        [
          'pub mod infrastructure;',
          'mod child {',
          '    use super::super::infrastructure::Repo;',
          '}',
        ].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });

      const explainedOk = explainFileArchitecture(ws, 'src/domain/order.rs', spec);
      const superImport = explainedOk.imports.find(
        (i) => i.specifier === 'super::super::infrastructure::Repo',
      );
      expect(superImport?.resolved_path).toBe('src/domain/infrastructure.rs');
      expect(superImport?.violations).toEqual([]);

      const repoOk = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoOk.passed).toBe(true);
      expect(repoOk.violations).toEqual([]);

      writeFileSync(
        join(ws, 'src/domain/order.rs'),
        ['mod child {', '    use super::super::super::infrastructure::Repo;', '}'].join('\n'),
      );
      const explainedBad = explainFileArchitecture(ws, 'src/domain/order.rs', spec);
      expect(explainedBad.imports[0]?.resolved_path).toBe('src/infrastructure/mod.rs');
      expect(explainedBad.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches domain-to-infrastructure violations preceded by unfinished import text in a string literal', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-str-swallow-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/infrastructure/foo.ts'), 'export const foo = 1;\n');
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        ['const example = "import {";', 'import { foo } from "../infrastructure/foo";'].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });
      const explained = explainFileArchitecture(ws, 'src/domain/order.ts', spec);
      expect(explained.imports.map((i) => i.specifier)).toEqual(['../infrastructure/foo']);
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches forbidden Python package imports in single-line compound statements under DDD', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-py-suite-'));
    try {
      mkdirSync(join(ws, 'app/domain'), { recursive: true });
      writeFileSync(join(ws, 'app/domain/service.py'), 'if True: import flask\n');

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'app',
      });
      const explained = explainFileArchitecture(ws, 'app/domain/service.py', spec);
      expect(explained.imports.map((i) => i.specifier)).toEqual(['flask']);
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:forbidden-package:domain',
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches Rust #[path = "..."] mod declarations targeting forbidden layers under DDD', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-rust-path-attr-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/lib.rs'), 'pub mod domain;\npub mod infrastructure;\n');
      writeFileSync(join(ws, 'src/infrastructure/repo.rs'), 'pub struct Repo;\n');
      writeFileSync(
        join(ws, 'src/domain/order.rs'),
        ['#[path = "../infrastructure/repo.rs"]', 'mod repo;'].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });

      const explained = explainFileArchitecture(ws, 'src/domain/order.rs', spec);
      expect(explained.imports[0]?.resolved_path).toBe('src/infrastructure/repo.rs');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves Cargo bin target imports rather than src/lib.rs in explain and repo checks', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-rust-bin-'));
    try {
      mkdirSync(join(ws, 'src/bin/worker/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/bin/worker/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
      writeFileSync(join(ws, 'src/lib.rs'), 'pub fn lib_ok() {}\n');
      writeFileSync(
        join(ws, 'src/bin/worker/main.rs'),
        'mod domain;\nmod infrastructure;\nfn main() {}\n',
      );
      writeFileSync(join(ws, 'src/bin/worker/infrastructure/mod.rs'), 'pub struct Repo;\n');
      writeFileSync(
        join(ws, 'src/bin/worker/domain/mod.rs'),
        'use crate::infrastructure::Repo;\npub fn run() { let _ = Repo; }\n',
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src/bin/worker',
      });

      const explained = explainFileArchitecture(ws, 'src/bin/worker/domain/mod.rs', spec);
      expect(explained.imports[0]?.resolved_path).toBe('src/bin/worker/infrastructure/mod.rs');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.file_path).toBe('src/bin/worker/domain/mod.rs');
      expect(repoRes.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches multiline Rust use imports split across lines under DDD', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-rust-multiline-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'src/lib.rs'), 'pub mod domain;\npub mod infrastructure;\n');
      writeFileSync(join(ws, 'src/infrastructure/mod.rs'), 'pub struct Repo;\n');
      writeFileSync(
        join(ws, 'src/domain/order.rs'),
        ['use crate::', '    infrastructure::Repo;', 'pub fn use_repo() { let _ = Repo; }'].join(
          '\n',
        ),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });

      const explained = explainFileArchitecture(ws, 'src/domain/order.rs', spec);
      expect(explained.imports[0]?.specifier).toBe('crate::infrastructure::Repo');
      expect(explained.imports[0]?.resolved_path).toBe('src/infrastructure/mod.rs');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches own Cargo library imports from binary targets under DDD', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-rust-own-lib-'));
    try {
      mkdirSync(join(ws, 'src/infrastructure'), { recursive: true });
      mkdirSync(join(ws, 'src/bin/worker/domain'), { recursive: true });
      writeFileSync(join(ws, 'Cargo.toml'), '[package]\nname = "arch_sample"\nversion = "0.1.0"\n');
      writeFileSync(join(ws, 'src/lib.rs'), 'pub mod infrastructure;\n');
      writeFileSync(join(ws, 'src/infrastructure/mod.rs'), 'pub struct Repo;\n');
      writeFileSync(join(ws, 'src/bin/worker/main.rs'), 'mod domain;\nfn main() {}\n');
      writeFileSync(
        join(ws, 'src/bin/worker/domain/mod.rs'),
        'use arch_sample::infrastructure::Repo;\npub fn run() { let _ = Repo; }\n',
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });

      const explained = explainFileArchitecture(ws, 'src/bin/worker/domain/mod.rs', spec);
      expect(explained.imports[0]?.package_name).toBeUndefined();
      expect(explained.imports[0]?.resolved_path).toBe('src/infrastructure/mod.rs');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.file_path).toBe('src/bin/worker/domain/mod.rs');
      expect(repoRes.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches cross-module Go workspace imports in explain and repo checks under DDD', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-go-work-'));
    try {
      mkdirSync(join(ws, 'app/domain'), { recursive: true });
      mkdirSync(join(ws, 'storage/infrastructure'), { recursive: true });
      writeFileSync(join(ws, 'go.work'), 'go 1.22\nuse (\n  ./app\n  ./storage\n)\n');
      writeFileSync(join(ws, 'app/go.mod'), 'module example.com/app\ngo 1.22\n');
      writeFileSync(join(ws, 'storage/go.mod'), 'module example.com/storage\ngo 1.22\n');
      writeFileSync(
        join(ws, 'storage/infrastructure/repo.go'),
        'package infrastructure\ntype Repo struct{}\n',
      );
      writeFileSync(
        join(ws, 'app/domain/order.go'),
        [
          'package domain',
          'import "example.com/storage/infrastructure"',
          'var _ infrastructure.Repo',
        ].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
      });

      const explained = explainFileArchitecture(ws, 'app/domain/order.go', spec);
      expect(explained.imports[0]?.resolved_path).toBe('storage/infrastructure');
      expect(explained.imports[0]?.target_layer).toBe('infrastructure');
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:domain-to-infrastructure',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(1);
      expect(repoRes.violations[0]?.file_path).toBe('app/domain/order.go');
      expect(repoRes.violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('catches C# static and alias Dapper type imports in domain under DDD without false-matching prefix names', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-csharp-dapper-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      writeFileSync(
        join(ws, 'src/domain/OrderRepository.cs'),
        [
          'using static Dapper.SqlMapper;',
          'using Sql = Dapper.SqlMapper;',
          'using static global::Dapper.SqlMapper;',
          'using Dapper.Contrib.Extensions;',
          'using Dapperness;',
          'namespace App.Domain;',
          'public class OrderRepository {}',
        ].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
      });

      const explained = explainFileArchitecture(ws, 'src/domain/OrderRepository.cs', spec);
      expect(explained.imports).toHaveLength(5);
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:forbidden-package:domain',
      ]);
      expect(explained.imports[1]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:forbidden-package:domain',
      ]);
      expect(explained.imports[2]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:forbidden-package:domain',
      ]);
      expect(explained.imports[3]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:forbidden-package:domain',
      ]);
      // Unrelated package whose name merely starts with "Dapper" must not trigger.
      expect(explained.imports[4]?.violations).toEqual([]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(4);
      expect(repoRes.violations.every((v) => v.rule_id === 'arch:forbidden-package:domain')).toBe(
        true,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('forbids modular-monolith shared kernel from importing feature module internals or public entrypoints', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-repo-scan-mm-shared-'));
    try {
      mkdirSync(join(ws, 'src/shared'), { recursive: true });
      mkdirSync(join(ws, 'src/modules/orders/shared'), { recursive: true });
      writeFileSync(join(ws, 'src/modules/orders/index.ts'), 'export const orderApi = 1;\n');
      writeFileSync(join(ws, 'src/modules/orders/internal.ts'), 'export const secret = 2;\n');
      writeFileSync(
        join(ws, 'src/shared/money.ts'),
        [
          "import { secret } from '../modules/orders/internal';",
          "import { orderApi } from '../modules/orders/index';",
          'export const sum = secret + orderApi;',
        ].join('\n'),
      );
      writeFileSync(
        join(ws, 'src/modules/orders/service.ts'),
        ["import { sum } from '../../shared/money';", 'export const run = () => sum;'].join('\n'),
      );
      // Nested shared folder inside a feature module remains in the `modules` layer.
      writeFileSync(
        join(ws, 'src/modules/orders/shared/helper.ts'),
        ["import { secret } from '../internal';", 'export const help = () => secret;'].join('\n'),
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'modular-monolith',
        root: 'src',
      });

      const explained = explainFileArchitecture(ws, 'src/shared/money.ts', spec);
      expect(explained.layer?.name).toBe('shared');
      expect(explained.imports.map((i) => i.target_layer)).toEqual(['modules', 'modules']);
      expect(explained.imports[0]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:shared-to-modules',
      ]);
      expect(explained.imports[1]?.violations.map((v) => v.rule_id)).toEqual([
        'arch:layer:shared-to-modules',
      ]);

      const repoRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      expect(repoRes.passed).toBe(false);
      expect(repoRes.violations).toHaveLength(2);
      expect(repoRes.violations.every((v) => v.file_path === 'src/shared/money.ts')).toBe(true);
      expect(repoRes.violations.every((v) => v.rule_id === 'arch:layer:shared-to-modules')).toBe(
        true,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
