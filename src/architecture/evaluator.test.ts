import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { classifyLayer, evaluateFileArchitecture } from './evaluator.js';
import { resolveArchitectureSpec } from './presets.js';

describe('classifyLayer', () => {
  it('picks more specific layer over parent layer regardless of order', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'hexagonal',
    });
    expect(classifyLayer('src/application/ports/order_repo.ts', spec)?.name).toBe('ports');
    expect(classifyLayer('src/application/place_order.ts', spec)?.name).toBe('application');
    expect(classifyLayer('src/adapters/in/http.ts', spec)?.name).toBe('adapters_in');
    expect(classifyLayer('src/adapters/out/pg.ts', spec)?.name).toBe('adapters_out');
    expect(classifyLayer('src/adapters/misc.ts', spec)?.name).toBe('adapters');
  });
});

describe('evaluateFileArchitecture — hexagonal', () => {
  const spec = resolveArchitectureSpec({
    ...DEFAULT_CONFIG.architecture,
    enabled: true,
    preset: 'hexagonal',
  });

  it('flags domain importing adapters_out, application, and forbidden packages', () => {
    const content = [
      "import express from 'express';",
      "import { PgRepo } from '../adapters/out/pg_repo';",
      "import { PlaceOrder } from '../application/place_order';",
      "import type { OrderRepo } from '../ports/order_repo';",
    ].join('\n');

    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.ts',
      content,
      spec,
      resolveCtx: {},
    });

    expect(violations.map((v) => v.rule_id)).toEqual([
      'arch:forbidden-package:domain',
      'arch:layer:domain-to-adapters_out',
      'arch:layer:domain-to-application',
    ]);
    expect(violations.map((v) => v.line)).toEqual([1, 2, 3]);
  });

  it('allows adapters_in -> application -> ports -> domain and blocks adapters_in -> adapters_out', () => {
    const content = [
      "import { PlaceOrder } from '../../application/place_order';",
      "import { PgRepo } from '../out/pg_repo';",
    ].join('\n');

    const violations = evaluateFileArchitecture({
      filePath: 'src/adapters/in/http_controller.ts',
      content,
      spec,
      resolveCtx: {},
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule_id).toBe('arch:layer:adapters_in-to-adapters_out');
  });

  it('skips test files when ignore_tests is true', () => {
    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.test.ts',
      content: "import { PgRepo } from '../adapters/out/pg_repo';",
      spec,
      resolveCtx: {},
    });
    expect(violations).toEqual([]);
  });

  it('filters violations to onlyLines when supplied (PR diff mode)', () => {
    const content = [
      "import { PgRepo } from '../adapters/out/pg_repo';",
      "import express from 'express';",
    ].join('\n');
    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.ts',
      content,
      spec,
      resolveCtx: {},
      onlyLines: new Set([2]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.rule_id).toBe('arch:forbidden-package:domain');
  });
});

describe('evaluateFileArchitecture — ddd bounded contexts & custom rules', () => {
  it('allows public API and barrel imports across contexts, blocks internal leaks', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      contexts: {
        pattern: 'src/contexts/*',
        public_api: ['index.*', 'public/**', 'contracts/**', 'api/**'],
        shared: ['src/shared/**'],
        allow_dependencies: {
          orders: ['billing', 'inventory'],
        },
      },
      rules: [
        {
          id: 'no-node-fs-in-domain',
          from: 'domain',
          forbid_packages: ['node:fs'],
          severity: 'critical',
          reason: 'Domain must be pure and free of filesystem side effects.',
        },
      ],
    });

    const content = [
      "import { BillingClient } from '../../billing';",
      "import { InvoiceDto } from '../../billing/contracts/invoice';",
      "import { InvoiceEntity } from '../../billing/domain/invoice';",
      "import { AuthService } from '../../auth/public/auth';",
      "import { Money } from '../../../shared/money';",
      "import fs from 'node:fs';",
    ].join('\n');

    const violations = evaluateFileArchitecture({
      filePath: 'src/contexts/orders/application/checkout.ts',
      content,
      spec,
      resolveCtx: {},
    });

    expect(violations.map((v) => [v.line, v.rule_id])).toEqual([
      [3, 'arch:context-boundary'],
      [4, 'arch:context-boundary'],
    ]);

    const domainViolations = evaluateFileArchitecture({
      filePath: 'src/contexts/orders/domain/order.ts',
      content: "import fs from 'node:fs';",
      spec,
      resolveCtx: {},
    });
    expect(domainViolations).toHaveLength(1);
    expect(domainViolations[0]?.rule_id).toBe('arch:rule:no-node-fs-in-domain');
    expect(domainViolations[0]?.severity).toBe('critical');
  });

  it('skips allow_packages when forbid_packages already flagged the same import', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'custom',
      layers: {
        domain: {
          paths: ['src/domain/**'],
          forbid_packages: ['express'],
          allow_packages: ['zod'],
        },
      },
    });

    const content = [
      "import express from 'express';",
      "import _ from 'lodash';",
      "import { z } from 'zod';",
    ].join('\n');

    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.ts',
      content,
      spec,
      resolveCtx: {},
    });
    expect(violations.map((v) => [v.line, v.rule_id])).toEqual([
      [1, 'arch:forbidden-package:domain'],
      [2, 'arch:disallowed-package:domain'],
    ]);
  });

  it('flags Python `from src import infrastructure` under the ddd preset', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'src',
    });

    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.py',
      content: 'from src import infrastructure\n',
      spec,
      resolveCtx: {},
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule_id).toBe('arch:layer:domain-to-infrastructure');
  });

  it('treats an empty can_import allowlist as forbidding all cross-layer imports while allowing intra-layer imports', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'custom',
      layers: {
        domain: {
          paths: ['src/domain/**'],
          can_import: [],
        },
        adapters: {
          paths: ['src/adapters/**'],
        },
      },
    });

    const content = [
      "import { Money } from './money';",
      "import { Repo } from '../adapters/repo';",
    ].join('\n');

    const violations = evaluateFileArchitecture({
      filePath: 'src/domain/order.ts',
      content,
      spec,
      resolveCtx: {},
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.rule_id).toBe('arch:layer:domain-to-adapters');
    expect(violations[0]?.description).toContain('`can_import: []`');
  });

  it('matches directory targets against contexts.shared, contexts.public_api, and forbid_imports', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'custom',
      contexts: {
        pattern: 'contexts/*',
        public_api: ['public/**'],
        shared: ['contexts/shared/**'],
        allow_dependencies: { orders: [] },
      },
      rules: [
        {
          id: 'no-legacy',
          from: '**',
          forbid_imports: ['src/Acme.Legacy/**'],
          reason: 'Legacy C# namespace is deprecated.',
        },
      ],
    });

    const goSharedOk = evaluateFileArchitecture({
      filePath: 'contexts/orders/order.go',
      content:
        'package orders\nimport (\n  "example.com/app/contexts/shared"\n  "example.com/app/contexts/billing/public"\n  "example.com/app/contexts/billing/internal"\n)\n',
      spec,
      resolveCtx: { goModule: 'example.com/app' },
    });
    expect(goSharedOk).toHaveLength(2);
    expect(goSharedOk.map((v) => [v.line, v.specifier, v.rule_id])).toEqual([
      [4, 'example.com/app/contexts/billing/public', 'arch:context-boundary'],
      [5, 'example.com/app/contexts/billing/internal', 'arch:context-boundary'],
    ]);

    // When cross-context dependency is permitted (or unconfigured), Go directory public_api passes while internal fails.
    const pubSpec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'custom',
      contexts: {
        pattern: 'contexts/*',
        public_api: ['public/**'],
        shared: ['contexts/shared/**'],
      },
    });
    const pubViolations = evaluateFileArchitecture({
      filePath: 'contexts/orders/order.go',
      content:
        'package orders\nimport (\n  "example.com/app/contexts/shared"\n  "example.com/app/contexts/billing/public"\n  "example.com/app/contexts/billing/internal"\n)\n',
      spec: pubSpec,
      resolveCtx: { goModule: 'example.com/app' },
    });
    expect(pubViolations).toHaveLength(1);
    expect(pubViolations[0]?.specifier).toBe('example.com/app/contexts/billing/internal');

    // Dotted C# directory target matches custom rule `forbid_imports: ['src/Acme.Legacy/**']`.
    const csViolations = evaluateFileArchitecture({
      filePath: 'src/Acme.Domain/Order.cs',
      content: 'namespace Acme.Domain;\nusing Acme.Legacy;\n',
      spec,
      resolveCtx: {},
    });
    expect(csViolations).toHaveLength(1);
    expect(csViolations[0]?.rule_id).toBe('arch:rule:no-legacy');
  });
});
