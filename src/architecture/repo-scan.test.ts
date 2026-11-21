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
});
