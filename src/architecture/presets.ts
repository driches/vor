/**
 * Built-in architecture presets (hexagonal, ddd, clean, layered,
 * modular-monolith, custom) and spec resolution from `.vor.yml` /
 * `.vor/architecture.yml`.
 */

import { stringify as stringifyYaml } from 'yaml';
import type {
  ArchitectureConfig,
  ArchitectureContextsConfig,
  ArchitectureCustomRule,
  ArchitectureLayerDef,
  ArchitectureLayerOverride,
  ArchitecturePresetId,
} from '../config/types.js';
import type { Severity } from '../types.js';
import { logger } from '../util/logger.js';
import { normalizePath } from './glob.js';

/**
 * Infrastructure, web-framework, and database client packages across all
 * supported languages that pure domain/entity layers should not import directly.
 */
export const DEFAULT_DOMAIN_FORBIDDEN_PACKAGES: readonly string[] = [
  // TypeScript / JavaScript
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/*',
  'prisma',
  '@prisma/client',
  'typeorm',
  'drizzle-orm',
  'sequelize',
  'mongoose',
  'knex',
  'pg',
  'mysql2',
  'ioredis',
  'redis',
  'axios',
  'node-fetch',
  'aws-sdk',
  '@aws-sdk/*',
  // Python
  'fastapi',
  'flask',
  'django',
  'starlette',
  'sqlalchemy',
  'psycopg2',
  'pymongo',
  'requests',
  'httpx',
  'aiohttp',
  'boto3',
  // Go
  'net/http',
  'database/sql',
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo*',
  'github.com/gofiber/fiber*',
  'gorm.io/gorm',
  'github.com/jackc/pgx*',
  // Dart / Flutter
  'http',
  'dio',
  'sqflite',
  'drift',
  'cloud_firestore',
  'firebase_*',
  // Rust
  'sqlx',
  'diesel',
  'sea_orm',
  'axum',
  'actix_web',
  'rocket',
  'reqwest',
  // Java / Kotlin
  'org.springframework.*',
  'jakarta.persistence.*',
  'javax.persistence.*',
  'org.hibernate.*',
  'java.sql.*',
  'io.ktor.*',
  // C# / .NET
  'Microsoft.EntityFrameworkCore*',
  'Microsoft.AspNetCore*',
  'System.Data.SqlClient*',
  'Dapper',
  'Dapper.*',
];

export interface ArchitecturePresetDefinition {
  id: ArchitecturePresetId;
  name: string;
  summary: string;
  layers: Record<string, ArchitectureLayerDef>;
  contexts?: ArchitectureContextsConfig;
  principles: string[];
}

export interface ResolvedArchitectureSpec {
  enabled: boolean;
  preset: ArchitecturePresetId;
  root?: string;
  severity: Severity;
  layers: Record<string, ArchitectureLayerDef>;
  contexts?: ArchitectureContextsConfig;
  rules: ArchitectureCustomRule[];
  principles: string[];
  llm_enforcement: boolean;
  deterministic_enforcement: boolean;
  exclude: string[];
  ignore_tests: boolean;
  baseline_file?: string;
}

// Scope built-in preset patterns under an optional repo root; user-supplied custom paths bypass this helper.
function scopeGlobsToRoot(globs: readonly string[], root?: string): string[] {
  if (!root) return [...globs];
  const cleanRoot = normalizePath(root);
  if (!cleanRoot) return [...globs];
  const scoped: string[] = [];
  for (const g of globs) {
    const norm = normalizePath(g);
    if (norm.startsWith('**/')) {
      const rest = norm.slice(3);
      // Emit both root-level layers (`src/domain/**`) and per-module nested
      // layers (`src/orders/domain/**`) while staying scoped inside `cleanRoot`.
      scoped.push(`${cleanRoot}/${rest}`, `${cleanRoot}/**/${rest}`);
    } else if (norm === cleanRoot || norm.startsWith(`${cleanRoot}/`)) {
      scoped.push(norm);
    } else {
      scoped.push(`${cleanRoot}/${norm}`);
    }
  }
  return scoped;
}

function buildPreset(id: ArchitecturePresetId, root?: string): ArchitecturePresetDefinition {
  const cleanRoot = root ? normalizePath(root) : undefined;

  switch (id) {
    case 'hexagonal':
      return {
        id: 'hexagonal',
        name: 'Hexagonal Architecture (Ports & Adapters)',
        summary:
          'Isolates pure domain and application core behind explicit ports; inbound and outbound adapters depend inward on ports/domain and never on each other.',
        layers: {
          domain: {
            description: 'Pure business entities, value objects, domain services, and invariants.',
            paths: scopeGlobsToRoot(['**/domain/**'], cleanRoot),
            can_import: ['domain', 'ports'],
            cannot_import: ['application', 'adapters_in', 'adapters_out', 'adapters'],
            forbid_packages: [...DEFAULT_DOMAIN_FORBIDDEN_PACKAGES],
          },
          ports: {
            description: 'Inbound and outbound interfaces owned by the core.',
            paths: scopeGlobsToRoot(['**/ports/**', '**/application/ports/**'], cleanRoot),
            can_import: ['ports', 'domain'],
            cannot_import: ['adapters_in', 'adapters_out', 'adapters'],
            forbid_packages: [...DEFAULT_DOMAIN_FORBIDDEN_PACKAGES],
          },
          application: {
            description: 'Use-case orchestrators coordinating domain objects through ports.',
            paths: scopeGlobsToRoot(
              ['**/application/**', '**/use-cases/**', '**/use_cases/**', '**/usecases/**'],
              cleanRoot,
            ),
            can_import: ['application', 'domain', 'ports'],
            cannot_import: ['adapters_in', 'adapters_out', 'adapters'],
          },
          adapters_in: {
            description:
              'Driving/inbound adapters (HTTP handlers, CLI commands, message consumers).',
            paths: scopeGlobsToRoot(
              [
                '**/adapters/in/**',
                '**/adapters/inbound/**',
                '**/adapters/driving/**',
                '**/adapters/primary/**',
                '**/driving/**',
                '**/inbound/**',
              ],
              cleanRoot,
            ),
            can_import: ['adapters_in', 'ports', 'application', 'domain'],
            cannot_import: ['adapters_out'],
          },
          adapters_out: {
            description: 'Driven/outbound adapters (DB repositories, HTTP clients, queues).',
            paths: scopeGlobsToRoot(
              [
                '**/adapters/out/**',
                '**/adapters/outbound/**',
                '**/adapters/driven/**',
                '**/adapters/secondary/**',
                '**/driven/**',
                '**/outbound/**',
                '**/infrastructure/**',
                '**/infra/**',
              ],
              cleanRoot,
            ),
            can_import: ['adapters_out', 'ports', 'domain'],
            cannot_import: ['adapters_in', 'application'],
          },
          adapters: {
            description: 'General adapter implementations when not split into inbound/outbound.',
            paths: scopeGlobsToRoot(['**/adapters/**'], cleanRoot),
            can_import: ['adapters', 'ports', 'application', 'domain'],
          },
        },
        principles: [
          'Keep business rules and domain state transitions inside `domain` and `application`, never in `adapters_in` controllers or `adapters_out` repositories.',
          'Ports belong to the core and must express signatures using domain entities, value objects, and domain errors — never framework/ORM/HTTP types.',
          'Inbound adapters should only parse/validate transport inputs, invoke an application use case or inbound port, and map the response.',
          'Outbound adapters must implement core port interfaces and translate persistence/network models at the boundary without leaking DB entities upward.',
          'Concrete adapter wiring and dependency injection belong only in the composition root (`main`, bootstrap, DI container).',
        ],
      };

    case 'ddd':
      return {
        id: 'ddd',
        name: 'Domain-Driven Design (DDD)',
        summary:
          'Separates tactical layers (domain, application, infrastructure, interfaces) and enforces bounded-context encapsulation through explicit public APIs.',
        layers: {
          domain: {
            description:
              'Aggregates, entities, value objects, domain events, and repository interfaces.',
            paths: scopeGlobsToRoot(['**/domain/**'], cleanRoot),
            can_import: ['domain', 'shared'],
            cannot_import: ['application', 'infrastructure', 'interfaces'],
            forbid_packages: [...DEFAULT_DOMAIN_FORBIDDEN_PACKAGES],
          },
          application: {
            description: 'Application services, command/query handlers, transaction boundaries.',
            paths: scopeGlobsToRoot(
              ['**/application/**', '**/use-cases/**', '**/use_cases/**', '**/usecases/**'],
              cleanRoot,
            ),
            can_import: ['application', 'domain', 'shared'],
            cannot_import: ['infrastructure', 'interfaces'],
          },
          infrastructure: {
            description: 'Persistence implementations, event buses, external integrations.',
            paths: scopeGlobsToRoot(
              ['**/infrastructure/**', '**/infra/**', '**/persistence/**'],
              cleanRoot,
            ),
            can_import: ['infrastructure', 'domain', 'application', 'shared'],
            cannot_import: ['interfaces'],
          },
          interfaces: {
            description: 'Delivery mechanisms (HTTP/GraphQL/gRPC/CLI/UI entry points).',
            paths: scopeGlobsToRoot(
              [
                '**/interfaces/**',
                '**/presentation/**',
                '**/controllers/**',
                '**/http/**',
                '**/ui/**',
              ],
              cleanRoot,
            ),
            can_import: ['interfaces', 'application', 'domain', 'shared'],
            cannot_import: ['infrastructure'],
          },
          shared: {
            description: 'Shared kernel primitives and cross-context value types.',
            paths: scopeGlobsToRoot(
              ['**/shared/**', '**/shared-kernel/**', '**/kernel/**'],
              cleanRoot,
            ),
            can_import: ['shared'],
            cannot_import: ['domain', 'application', 'infrastructure', 'interfaces'],
          },
        },
        contexts: {
          pattern: cleanRoot ? `${cleanRoot}/contexts/*` : '**/contexts/*',
          public_api: ['index.*', 'public/**', 'contracts/**', 'api/**'],
          shared: scopeGlobsToRoot(
            ['**/shared/**', '**/shared-kernel/**', '**/kernel/**'],
            cleanRoot,
          ),
          allow_public_api_imports: true,
        },
        principles: [
          'Enforce aggregate root invariants inside aggregate methods rather than allowing external services to mutate internal entities directly (avoid anemic domain models).',
          'Model domain concepts as immutable, self-validating Value Objects instead of primitive obsession where domain constraints apply.',
          'Bounded contexts must communicate only via explicit public APIs/contracts or domain events; use Anti-Corruption Layers when translating foreign models.',
          'Repositories should load and persist whole aggregates using domain language rather than exposing raw ORM query builders to callers.',
          'Maintain ubiquitous language consistently across types, methods, events, and modules within each bounded context.',
        ],
      };

    case 'clean':
      return {
        id: 'clean',
        name: 'Clean Architecture',
        summary:
          'Enforces the concentric Dependency Rule: source dependencies may point only inward from frameworks -> interface adapters -> use cases -> entities.',
        layers: {
          entities: {
            description: 'Enterprise-wide business rules and core entities.',
            paths: scopeGlobsToRoot(['**/entities/**', '**/domain/**'], cleanRoot),
            can_import: ['entities'],
            cannot_import: ['use_cases', 'interface_adapters', 'frameworks'],
            forbid_packages: [...DEFAULT_DOMAIN_FORBIDDEN_PACKAGES],
          },
          use_cases: {
            description: 'Application-specific business rules and interactors.',
            paths: scopeGlobsToRoot(
              [
                '**/use-cases/**',
                '**/use_cases/**',
                '**/usecases/**',
                '**/application/**',
                '**/interactors/**',
              ],
              cleanRoot,
            ),
            can_import: ['use_cases', 'entities'],
            cannot_import: ['interface_adapters', 'frameworks'],
          },
          interface_adapters: {
            description: 'Controllers, presenters, gateways, and view models.',
            paths: scopeGlobsToRoot(
              [
                '**/interface-adapters/**',
                '**/adapters/**',
                '**/controllers/**',
                '**/presenters/**',
                '**/gateways/**',
              ],
              cleanRoot,
            ),
            can_import: ['interface_adapters', 'use_cases', 'entities'],
            cannot_import: ['frameworks'],
          },
          frameworks: {
            description: 'Web frameworks, database drivers, external devices.',
            paths: scopeGlobsToRoot(
              ['**/frameworks/**', '**/drivers/**', '**/infrastructure/**', '**/infra/**'],
              cleanRoot,
            ),
            can_import: ['frameworks', 'interface_adapters', 'use_cases', 'entities'],
          },
        },
        principles: [
          'Follow the Dependency Rule strictly: inner circles (`entities`, `use_cases`) must have zero knowledge of outer circles (`interface_adapters`, `frameworks`).',
          'Keep enterprise rules in `entities` separate from application orchestration in `use_cases`.',
          'Boundary input/output DTOs must be defined and owned by the inner layer (`use_cases`), not by web frameworks or ORM models.',
        ],
      };

    case 'layered':
      return {
        id: 'layered',
        name: 'Classic Layered (N-Tier) Architecture',
        summary:
          'Separates presentation -> service -> data -> model layers so requests flow downward without presentation bypassing services to touch persistence.',
        layers: {
          presentation: {
            description: 'HTTP routes, controllers, views, and UI components.',
            paths: scopeGlobsToRoot(
              [
                '**/presentation/**',
                '**/controllers/**',
                '**/routes/**',
                '**/views/**',
                '**/api/**',
                '**/ui/**',
              ],
              cleanRoot,
            ),
            can_import: ['presentation', 'service', 'model', 'shared'],
            cannot_import: ['data'],
          },
          service: {
            description: 'Business services and domain logic.',
            paths: scopeGlobsToRoot(
              ['**/services/**', '**/service/**', '**/business/**', '**/domain/**'],
              cleanRoot,
            ),
            can_import: ['service', 'data', 'model', 'shared'],
            cannot_import: ['presentation'],
          },
          data: {
            description: 'Repositories, DAOs, and persistence queries.',
            paths: scopeGlobsToRoot(
              [
                '**/data/**',
                '**/repositories/**',
                '**/repository/**',
                '**/dal/**',
                '**/persistence/**',
                '**/db/**',
              ],
              cleanRoot,
            ),
            can_import: ['data', 'model', 'shared'],
            cannot_import: ['presentation', 'service'],
          },
          model: {
            description: 'Shared domain models, DTOs, and schemas.',
            paths: scopeGlobsToRoot(
              ['**/models/**', '**/model/**', '**/types/**', '**/schemas/**'],
              cleanRoot,
            ),
            can_import: ['model', 'shared'],
            cannot_import: ['presentation', 'service', 'data'],
          },
          shared: {
            description: 'Cross-cutting utilities.',
            paths: scopeGlobsToRoot(
              ['**/shared/**', '**/common/**', '**/utils/**', '**/util/**'],
              cleanRoot,
            ),
            can_import: ['shared'],
            cannot_import: ['presentation', 'service', 'data'],
          },
        },
        principles: [
          'Keep `presentation` handlers thin: no direct SQL/ORM queries or multi-step business logic inside controllers or route handlers.',
          'Keep `data` repositories focused on persistence mechanics without embedding authorization or pricing/business rules.',
          'Never introduce upward dependencies from lower layers (`data`, `service`) back into `presentation`.',
        ],
      };

    case 'modular-monolith':
      return {
        id: 'modular-monolith',
        name: 'Modular Monolith',
        summary:
          'Enforces strong module boundaries where feature modules interact exclusively through declared public entrypoints or a lean shared kernel.',
        layers: {
          shared: {
            description:
              'Shared kernel primitives with zero upward dependencies on feature modules.',
            paths: scopeGlobsToRoot(['**/shared/**', '**/common/**', '**/kernel/**'], cleanRoot),
            can_import: ['shared'],
          },
        },
        contexts: {
          pattern: cleanRoot ? `${cleanRoot}/modules/*` : '**/modules/*',
          public_api: ['index.*', 'public/**', 'api/**', 'contracts/**'],
          shared: scopeGlobsToRoot(['**/shared/**', '**/common/**', '**/kernel/**'], cleanRoot),
          allow_public_api_imports: true,
        },
        principles: [
          'Feature modules must expose a clean public facade (`index`, `public/`, or `contracts/`) and never leak internal repositories, tables, or private helpers.',
          'Keep the `shared` kernel minimal — avoid turning `shared` into a dumping ground that hides cross-module coupling.',
          'Avoid circular module dependencies; prefer event-driven decoupling or an explicit orchestration module when cycles emerge.',
        ],
      };

    case 'custom':
      return {
        id: 'custom',
        name: 'Custom Architecture',
        summary: 'User-defined layers, bounded contexts, import rules, and semantic principles.',
        layers: {},
        principles: [],
      };
  }
}

function mergeLayerOverride(
  base: ArchitectureLayerDef | undefined,
  override: ArchitectureLayerOverride,
): ArchitectureLayerDef | null {
  const paths = override.paths ?? base?.paths;
  if (!paths || paths.length === 0) {
    // A user override referencing an unknown layer without `paths` cannot match
    // files; skip it safely instead of crashing a PR review.
    return null;
  }
  return {
    paths: [...paths],
    ...(override.description !== undefined
      ? { description: override.description }
      : base?.description !== undefined
        ? { description: base.description }
        : {}),
    ...(override.can_import !== undefined
      ? { can_import: [...override.can_import] }
      : base?.can_import !== undefined
        ? { can_import: [...base.can_import] }
        : {}),
    ...(override.cannot_import !== undefined
      ? { cannot_import: [...override.cannot_import] }
      : base?.cannot_import !== undefined
        ? { cannot_import: [...base.cannot_import] }
        : {}),
    ...(override.forbid_packages !== undefined
      ? { forbid_packages: [...override.forbid_packages] }
      : base?.forbid_packages !== undefined
        ? { forbid_packages: [...base.forbid_packages] }
        : {}),
    ...(override.allow_packages !== undefined
      ? { allow_packages: [...override.allow_packages] }
      : base?.allow_packages !== undefined
        ? { allow_packages: [...base.allow_packages] }
        : {}),
    ...(override.severity !== undefined
      ? { severity: override.severity }
      : base?.severity !== undefined
        ? { severity: base.severity }
        : {}),
  };
}

/**
 * Resolve a user {@link ArchitectureConfig} by expanding the selected preset
 * (defaulting to `'hexagonal'` when `preset` is omitted and `layers`/`contexts`/`rules`
 * aren't provided, or `'custom'` when user-defined rules exist without a preset)
 * and merging user overrides on top.
 */
export function resolveArchitectureSpec(config: ArchitectureConfig): ResolvedArchitectureSpec {
  const hasCustomStructure =
    (config.layers !== undefined && Object.keys(config.layers).length > 0) ||
    config.contexts !== undefined ||
    (config.rules !== undefined && config.rules.length > 0);
  const presetId: ArchitecturePresetId =
    config.preset ?? (hasCustomStructure ? 'custom' : 'hexagonal');

  const preset = buildPreset(presetId, config.root);
  const layers: Record<string, ArchitectureLayerDef> = {};

  for (const [name, def] of Object.entries(preset.layers)) {
    const override = config.layers?.[name];
    const merged = override ? mergeLayerOverride(def, override) : { ...def, paths: [...def.paths] };
    if (merged) layers[name] = merged;
  }

  if (config.layers) {
    for (const [name, override] of Object.entries(config.layers)) {
      if (layers[name]) continue;
      const added = mergeLayerOverride(undefined, override);
      if (added) {
        layers[name] = added;
      } else {
        void logger.warn(
          `Architecture layer '${name}' has no paths and does not match a preset layer; ignoring.`,
        );
      }
    }
  }

  const contexts = config.contexts ?? preset.contexts;
  const includePresetPrinciples = config.include_preset_principles !== false;
  const principles = [
    ...(includePresetPrinciples ? preset.principles : []),
    ...(config.principles ?? []),
  ];

  // Filter out incomplete custom rules that have neither import nor package targets.
  const rules = (config.rules ?? []).filter(
    (r) =>
      (r.forbid_imports !== undefined && r.forbid_imports.length > 0) ||
      (r.forbid_packages !== undefined && r.forbid_packages.length > 0),
  );

  return {
    enabled: config.enabled,
    preset: presetId,
    ...(config.root !== undefined ? { root: normalizePath(config.root) } : {}),
    severity: config.severity,
    layers,
    ...(contexts !== undefined ? { contexts } : {}),
    rules,
    principles,
    llm_enforcement: config.llm_enforcement,
    deterministic_enforcement: config.deterministic_enforcement,
    exclude: [...(config.exclude ?? [])],
    ignore_tests: config.ignore_tests,
    ...(config.baseline_file !== undefined ? { baseline_file: config.baseline_file } : {}),
  };
}

export function listPresets(): ArchitecturePresetDefinition[] {
  const ids: ArchitecturePresetId[] = [
    'hexagonal',
    'ddd',
    'clean',
    'layered',
    'modular-monolith',
    'custom',
  ];
  return ids.map((id) => buildPreset(id));
}

export function generateStarterYaml(
  presetId: ArchitecturePresetId,
  opts: { root?: string } = {},
): string {
  const preset = buildPreset(presetId, opts.root);
  const layerSample: Record<string, { paths: string[] }> = {};
  for (const [name, def] of Object.entries(preset.layers)) {
    layerSample[name] = { paths: [...def.paths] };
  }

  const doc: Record<string, unknown> = {
    enabled: true,
    preset: presetId,
    ...(opts.root ? { root: normalizePath(opts.root) } : {}),
    severity: 'important',
    llm_enforcement: true,
    deterministic_enforcement: true,
    ignore_tests: true,
    ...(Object.keys(layerSample).length > 0 ? { layers: layerSample } : {}),
    ...(preset.contexts ? { contexts: preset.contexts } : {}),
    ...(presetId === 'custom'
      ? {
          layers: {
            domain: {
              paths: ['src/domain/**'],
              can_import: ['domain'],
              forbid_packages: ['express', 'prisma'],
            },
            infrastructure: {
              paths: ['src/infrastructure/**'],
              can_import: ['infrastructure', 'domain'],
            },
          },
        }
      : {}),
    principles:
      preset.principles.length > 0
        ? preset.principles.slice(0, 3)
        : ['Keep domain logic decoupled from framework and persistence dependencies.'],
  };

  return (
    `# Vor architecture standards configuration (${preset.name})\n` +
    `# Generated by \`vor arch init --preset ${presetId}\`\n` +
    stringifyYaml(doc)
  );
}
