import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
});
