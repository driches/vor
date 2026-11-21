import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectArchLanguage,
  extractImports,
  loadWorkspaceResolveContext,
  parseGoModModule,
  parsePubspecName,
  parseTsConfigContent,
  resolveImport,
  resolveImports,
  stripCLikeComments,
  stripPythonCommentsAndDocstrings,
} from './imports.js';

describe('detectArchLanguage', () => {
  it('maps extensions for all supported languages', () => {
    expect(detectArchLanguage('src/a.ts')).toBe('typescript');
    expect(detectArchLanguage('src/a.mts')).toBe('typescript');
    expect(detectArchLanguage('src/a.jsx')).toBe('javascript');
    expect(detectArchLanguage('app/a.py')).toBe('python');
    expect(detectArchLanguage('pkg/a.go')).toBe('go');
    expect(detectArchLanguage('lib/a.dart')).toBe('dart');
    expect(detectArchLanguage('src/a.rs')).toBe('rust');
    expect(detectArchLanguage('src/A.java')).toBe('java');
    expect(detectArchLanguage('src/A.kt')).toBe('kotlin');
    expect(detectArchLanguage('src/A.cs')).toBe('csharp');
    expect(detectArchLanguage('README.md')).toBeNull();
  });
});

describe('comment stripping preserves line numbers', () => {
  it('strips C-like comments while keeping newlines and strings intact', () => {
    const src = [
      '// import "express"',
      '/* multi',
      '   import "prisma"',
      '*/',
      'import x from "./real"; // trailing comment',
    ].join('\n');
    const stripped = stripCLikeComments(src);
    expect(stripped.split('\n')).toHaveLength(5);
    expect(stripped).not.toContain('express');
    expect(stripped).not.toContain('prisma');
    expect(stripped).toContain('import x from "./real"');
  });

  it('strips Python comments and docstrings without shifting lines', () => {
    const src = [
      '"""',
      'import flask',
      'from sqlalchemy import Column',
      '"""',
      '# import requests',
      'from ..infra.db import Repo',
    ].join('\n');
    const stripped = stripPythonCommentsAndDocstrings(src);
    expect(stripped.split('\n')).toHaveLength(6);
    expect(stripped).not.toContain('flask');
    expect(stripped).not.toContain('requests');
    expect(stripped).toContain('from ..infra.db import Repo');
  });
});

describe('extractImports & resolveImport across languages', () => {
  it('extracts and resolves TS/JS static, multi-line, dynamic, require, and tsconfig paths', () => {
    const src = [
      "import { Order } from './order.js';",
      'import type {',
      '  UserRepo,',
      "} from '@/adapters/out/repo';",
      "const express = require('express');",
      "const dyn = await import('../adapters/in/http');",
    ].join('\n');

    const { imports } = extractImports('src/domain/service.ts', src);
    expect(imports.map((i) => [i.specifier, i.line])).toEqual([
      ['./order.js', 1],
      ['@/adapters/out/repo', 4],
      ['express', 5],
      ['../adapters/in/http', 6],
    ]);

    const tsconfig = parseTsConfigContent(`{
      // comment
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"],
        },
      }
    }`);
    const knownFiles = new Set(['src/domain/order.ts', 'src/adapters/out/repo.ts']);
    const ctx = { tsconfig, knownFiles };
    const resolved = imports.map((i) => resolveImport(i, 'src/domain/service.ts', ctx));
    expect(resolved[0]?.resolvedPath).toBe('src/domain/order.ts');
    expect(resolved[1]?.resolvedPath).toBe('src/adapters/out/repo.ts');
    expect(resolved[2]?.packageName).toBe('express');
    expect(resolved[3]?.resolvedPath).toBe('src/adapters/in/http');
  });

  it('extracts and resolves Python relative and internal package imports', () => {
    const src = [
      'from ..adapters.db import PostgresRepo',
      'from app.infrastructure.mail import send',
      'import fastapi, sqlalchemy as sa',
    ].join('\n');
    const { imports } = extractImports('app/domain/order.py', src);
    expect(imports.map((i) => i.specifier)).toEqual([
      '..adapters.db',
      'app.infrastructure.mail',
      'fastapi',
      'sqlalchemy',
    ]);
    const resolved = imports.map((i) => resolveImport(i, 'app/domain/order.py', {}));
    expect(resolved[0]?.resolvedPath).toBe('app/adapters/db');
    expect(resolved[1]?.resolvedPath).toBe('app/infrastructure/mail');
    expect(resolved[2]?.packageName).toBe('fastapi');
    expect(resolved[3]?.packageName).toBe('sqlalchemy');
  });

  it('extracts and resolves Go grouped/single imports via go.mod', () => {
    const src = [
      'package domain',
      'import (',
      '  "net/http"',
      '  repo "github.com/acme/orders/internal/adapters/out/pg"',
      ')',
      'import "github.com/gin-gonic/gin"',
    ].join('\n');
    const { imports } = extractImports('internal/domain/order.go', src);
    const goModule = parseGoModModule('module github.com/acme/orders\ngo 1.22\n');
    const resolved = imports.map((i) => resolveImport(i, 'internal/domain/order.go', { goModule }));
    expect(resolved[0]?.packageName).toBe('net/http');
    expect(resolved[1]?.resolvedPath).toBe('internal/adapters/out/pg');
    expect(resolved[2]?.packageName).toBe('github.com/gin-gonic/gin');
  });

  it('extracts and resolves Dart package and relative imports via pubspec.yaml', () => {
    const src = [
      "import 'package:my_app/adapters/out/db.dart';",
      "import 'package:http/http.dart';",
      "import '../ports/repo.dart';",
    ].join('\n');
    const { imports } = extractImports('lib/domain/order.dart', src);
    const dartPackage = parsePubspecName('name: my_app\n');
    const resolved = imports.map((i) => resolveImport(i, 'lib/domain/order.dart', { dartPackage }));
    expect(resolved[0]?.resolvedPath).toBe('lib/adapters/out/db.dart');
    expect(resolved[1]?.packageName).toBe('http');
    expect(resolved[2]?.resolvedPath).toBe('lib/ports/repo.dart');
  });

  it('extracts and resolves Rust grouped use trees, mod, and external crates', () => {
    const src = [
      'use crate::adapters::{',
      '    out::pg_repo,',
      '    in::http_handler as handler,',
      '};',
      'use sqlx::PgPool;',
      'mod helper;',
    ].join('\n');
    const { imports } = extractImports('src/domain/order.rs', src);
    expect(imports.map((i) => [i.specifier, i.line])).toEqual([
      ['crate::adapters::out::pg_repo', 2],
      ['crate::adapters::in::http_handler', 3],
      ['sqlx::PgPool', 5],
      ['mod:helper', 6],
    ]);
    const resolved = imports.map((i) => resolveImport(i, 'src/domain/order.rs', {}));
    expect(resolved[0]?.resolvedPath).toBe('src/adapters/out/pg_repo');
    expect(resolved[1]?.resolvedPath).toBe('src/adapters/in/http_handler');
    expect(resolved[2]?.packageName).toBe('sqlx');
    expect(resolved[3]?.resolvedPath).toBe('src/domain/order/helper.rs');
  });

  it('extracts and resolves Java/Kotlin and C# imports and package/namespace roots', () => {
    const javaSrc = [
      'package com.acme.orders.domain;',
      'import com.acme.orders.infrastructure.JdbcRepo;',
      'import org.springframework.stereotype.Service;',
    ].join('\n');
    const javaParsed = extractImports('src/main/java/com/acme/orders/domain/Order.java', javaSrc);
    const javaRes = javaParsed.imports.map((i) =>
      resolveImport(i, 'src/main/java/com/acme/orders/domain/Order.java', {}, javaParsed.meta),
    );
    expect(javaRes[0]?.resolvedPath).toBe('src/main/java/com/acme/orders/infrastructure/JdbcRepo');
    expect(javaRes[1]?.packageName).toBe('org.springframework.stereotype.Service');

    const csSrc = [
      'namespace Acme.Domain;',
      'using Acme.Infrastructure.Persistence;',
      'using Microsoft.EntityFrameworkCore;',
      'using (var stream = open()) {}',
    ].join('\n');
    const csParsed = extractImports('Domain/Order.cs', csSrc);
    expect(csParsed.imports.map((i) => i.specifier)).toEqual([
      'Acme.Infrastructure.Persistence',
      'Microsoft.EntityFrameworkCore',
    ]);
    const csRes = csParsed.imports.map((i) =>
      resolveImport(i, 'Domain/Order.cs', {}, csParsed.meta),
    );
    expect(csRes[0]?.resolvedPath).toBe('Acme/Infrastructure/Persistence');
    expect(csRes[1]?.packageName).toBe('Microsoft.EntityFrameworkCore');
  });

  it('loads tsconfig.json, go.mod, and pubspec.yaml from workspaceDir', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-ws-ctx-'));
    try {
      mkdirSync(join(ws, 'src'), { recursive: true });
      writeFileSync(
        join(ws, 'tsconfig.json'),
        '{"compilerOptions":{"baseUrl":".","paths":{"@core/*":["src/core/*"]}}}',
      );
      writeFileSync(join(ws, 'go.mod'), 'module example.com/svc\n');
      writeFileSync(join(ws, 'pubspec.yaml'), 'name: sample_app\n');
      const ctx = loadWorkspaceResolveContext(ws);
      expect(ctx.tsconfig?.paths['@core/*']).toEqual(['src/core/*']);
      expect(ctx.goModule).toBe('example.com/svc');
      expect(ctx.dartPackage).toBe('sample_app');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ignores imports inside string and template literals while keeping template interpolations and Rust lifetimes', () => {
    const jsSrc = [
      'const example = `',
      '  import express from "express";',
      "  const q = require('fastify');",
      '`;',
      'const quoted = "import prisma from \'prisma\';";',
      "const real = `ok ${require('pg')}`;",
    ].join('\n');
    const jsImports = extractImports('src/domain/gen.ts', jsSrc).imports;
    expect(jsImports.map((i) => [i.specifier, i.line])).toEqual([['pg', 6]]);

    const goSrc = [
      'package domain',
      'const tmpl = `',
      'import "net/http"',
      '`',
      'import "context"',
    ].join('\n');
    const goImports = extractImports('internal/domain/gen.go', goSrc).imports;
    expect(goImports.map((i) => i.specifier)).toEqual(['context']);

    const rustSrc = [
      "fn hold<'a>(s: &'a str) -> &'a str { s }",
      'const EXAMPLE: &str = "use crate::adapters::db;";',
      'const RAW: &str = r#"use reqwest::Client;"#;',
      'use crate::ports::Repo;',
    ].join('\n');
    const rustImports = extractImports('src/domain/item.rs', rustSrc).imports;
    expect(rustImports.map((i) => i.specifier)).toEqual(['crate::ports::Repo']);
  });

  it('resolves submodules named in Python from-import lists and relative from-imports', () => {
    const single = extractImports('src/domain/order.py', 'from src import infrastructure');
    const resolvedSingle = resolveImports(single.imports, 'src/domain/order.py', {});
    expect(resolvedSingle[0]?.resolvedPath).toBe('src/infrastructure');

    const multi = extractImports(
      'src/domain/order.py',
      ['from src import (', '  infrastructure,', '  adapters as adm,', ')'].join('\n'),
    );
    const knownFiles = new Set([
      'src/infrastructure/__init__.py',
      'src/infrastructure/repository.py',
      'src/adapters/db.py',
    ]);
    const resolvedMulti = resolveImports(multi.imports, 'src/domain/order.py', { knownFiles });
    expect(resolvedMulti.map((r) => [r.resolvedPath, r.line])).toEqual([
      ['src/infrastructure/__init__.py', 2],
      ['src/adapters', 3],
    ]);

    const rel = extractImports('src/domain/order.py', 'from .. import infrastructure');
    const resolvedRel = resolveImports(rel.imports, 'src/domain/order.py', { knownFiles });
    expect(resolvedRel[0]?.resolvedPath).toBe('src/infrastructure/__init__.py');

    const dotted = extractImports(
      'src/domain/order.py',
      'from src.infrastructure import repository',
    );
    const resolvedDotted = resolveImports(dotted.imports, 'src/domain/order.py', { knownFiles });
    expect(resolvedDotted[0]?.resolvedPath).toBe('src/infrastructure/repository.py');
  });

  it('resolves Rust super:: and self:: from the logical module path', () => {
    const fileSrc = ['use super::super::infrastructure::Repo;', 'use self::sub::Helper;'].join(
      '\n',
    );
    const parsedFile = extractImports('src/domain/order.rs', fileSrc);
    expect(
      parsedFile.imports.map((i) => resolveImport(i, 'src/domain/order.rs', {}).resolvedPath),
    ).toEqual(['src/infrastructure/Repo', 'src/domain/order/sub/Helper']);

    const modSrc = 'use super::infrastructure::Repo;\n';
    const parsedMod = extractImports('src/domain/mod.rs', modSrc);
    expect(resolveImport(parsedMod.imports[0]!, 'src/domain/mod.rs', {}).resolvedPath).toBe(
      'src/infrastructure/Repo',
    );
  });

  it('resolves Rust item imports to the longest existing containing module', () => {
    const knownFiles = new Set([
      'src/lib.rs',
      'src/modules/orders/mod.rs',
      'src/modules/orders/internal.rs',
      'src/modules/orders/sub.rs',
      'src/modules/billing/service.rs',
      'crates/nested/src/lib.rs',
    ]);
    const ctx = { knownFiles };

    const crateSrc = [
      'use crate::modules::orders::Order;',
      'use crate::modules::orders::OrderStatus::Pending;',
      'use crate::modules::orders::internal::Secret;',
      'use crate::AppConfig;',
    ].join('\n');
    const parsedCrate = extractImports('src/modules/billing/service.rs', crateSrc);
    expect(
      resolveImports(parsedCrate.imports, 'src/modules/billing/service.rs', ctx).map(
        (r) => r.resolvedPath,
      ),
    ).toEqual([
      'src/modules/orders/mod.rs',
      'src/modules/orders/mod.rs',
      'src/modules/orders/internal.rs',
      'src/lib.rs',
    ]);

    const relSrc = [
      'use super::super::orders::Order;',
      'use super::super::orders::internal::Secret;',
    ].join('\n');
    const parsedRel = extractImports('src/modules/billing/service.rs', relSrc);
    expect(
      resolveImports(parsedRel.imports, 'src/modules/billing/service.rs', ctx).map(
        (r) => r.resolvedPath,
      ),
    ).toEqual(['src/modules/orders/mod.rs', 'src/modules/orders/internal.rs']);

    const selfSrc = 'use self::sub::Helper;\n';
    const parsedSelf = extractImports('src/modules/orders/mod.rs', selfSrc);
    expect(
      resolveImport(parsedSelf.imports[0]!, 'src/modules/orders/mod.rs', ctx).resolvedPath,
    ).toBe('src/modules/orders/sub.rs');

    const nestedSrc = 'use crate::Missing;\n';
    const parsedNested = extractImports('crates/nested/src/app.rs', nestedSrc);
    expect(
      resolveImport(parsedNested.imports[0]!, 'crates/nested/src/app.rs', ctx).resolvedPath,
    ).toBe('crates/nested/src/lib.rs');
  });

  it('resolves Rust mod declarations beneath non-dir module files rather than sibling paths', () => {
    const knownFiles = new Set([
      'src/infrastructure.rs',
      'src/domain.rs',
      'src/domain/infrastructure.rs',
      'src/domain/nested/mod.rs',
    ]);
    const ctx = { knownFiles };

    const fromDomainFile = extractImports('src/domain.rs', 'mod infrastructure;\nmod nested;\n');
    expect(
      resolveImports(fromDomainFile.imports, 'src/domain.rs', ctx).map((r) => r.resolvedPath),
    ).toEqual(['src/domain/infrastructure.rs', 'src/domain/nested/mod.rs']);

    const fromDomainMod = extractImports('src/domain/mod.rs', 'mod infrastructure;\n');
    expect(resolveImport(fromDomainMod.imports[0]!, 'src/domain/mod.rs', ctx).resolvedPath).toBe(
      'src/domain/infrastructure.rs',
    );

    const fromLib = extractImports('src/lib.rs', 'mod domain;\nmod infrastructure;\n');
    expect(resolveImports(fromLib.imports, 'src/lib.rs', ctx).map((r) => r.resolvedPath)).toEqual([
      'src/domain.rs',
      'src/infrastructure.rs',
    ]);
  });

  it('ignores JS/TS import syntax inside regex literals while preserving division and JSX', () => {
    const src = [
      'const pattern = /import express from "express"/;',
      "const fn = () => { return /require('pg')/; };",
      "const escaped = /foo\\/bar import 'fastify' [a/b]/gi;",
      "if (ok) /import 'prisma'/.test(s);",
      "const ratio = a / b; import { ok } from './ok'; const r2 = (c + d) / e;",
      "const el = <div><span>a</span>{require('pg')}<span>b</span></div>;",
      "const el2 = <Icon prop={1} /> && require('zod') && <Other prop={2} />;",
    ].join('\n');

    const imports = extractImports('src/component.tsx', src).imports;
    expect(imports.map((i) => [i.specifier, i.line])).toEqual([
      ['./ok', 5],
      ['pg', 6],
      ['zod', 7],
    ]);
  });

  it('ignores JSX text in .tsx/.jsx while preserving JSX expression containers and TS generics', () => {
    const preExample =
      'export function Doc() { return <pre>import express from "express";</pre>; }\n';
    expect(extractImports('src/Doc.tsx', preExample).imports).toEqual([]);

    const mixed = [
      "import { ok } from './ok';",
      'const id = <T,>(x: T) => x;',
      'const fn = <T extends object>(x: T) => x;',
      'export function View({ items }: { items: string[] }) {',
      '  return (',
      '    <div>',
      "      <p>Don't import \"express\" or require('fs')</p>",
      "      <button onClick={() => 1}>import 'fastify'</button>",
      "      <>import 'prisma'{require('zod')}</>",
      "      {items.map((x) => <span>{require('pg')}</span>)}",
      '    </div>',
      '  );',
      '}',
    ].join('\n');

    const extracted = extractImports('src/View.tsx', mixed).imports;
    expect(extracted.map((i) => [i.specifier, i.line])).toEqual([
      ['./ok', 1],
      ['zod', 9],
      ['pg', 10],
    ]);
  });

  it('rebases inherited paths against the child baseUrl when child overrides baseUrl without paths', () => {
    const files: Record<string, string> = {
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          baseUrl: 'src/shared',
          paths: {
            '@app/*': ['*'],
          },
        },
      }),
    };

    const parsed = parseTsConfigContent(
      JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: {
          baseUrl: './src/infrastructure',
        },
      }),
      (rel) => files[rel] ?? null,
    );

    expect(parsed?.baseUrl).toBe('src/infrastructure');
    expect(parsed?.paths).toEqual({
      '@app/*': ['src/infrastructure/*'],
    });

    const knownFiles = new Set(['src/shared/repo.ts', 'src/infrastructure/repo.ts']);
    const imp = extractImports('src/domain/service.ts', "import { Repo } from '@app/repo';")
      .imports[0]!;
    expect(
      resolveImport(imp, 'src/domain/service.ts', { tsconfig: parsed, knownFiles }).resolvedPath,
    ).toBe('src/infrastructure/repo.ts');
  });

  it('rebases inherited tsconfig baseUrl, paths, and nested extends relative to their defining directory', () => {
    const files: Record<string, string> = {
      'config/base.json': JSON.stringify({
        extends: './common/shared.json',
      }),
      'config/common/shared.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@domain/*': ['../../src/domain/*'],
          },
        },
      }),
      'config/infra-base.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: {
            '@infra/*': ['src/infrastructure/*'],
          },
        },
      }),
    };

    // Nested extends: without an overriding baseUrl, grandparent paths rebase from config/common/.
    const nested = parseTsConfigContent(
      JSON.stringify({ extends: './config/base.json' }),
      (rel) => files[rel] ?? null,
    );
    expect(nested?.baseUrl).toBeUndefined();
    expect(nested?.paths).toEqual({
      '@domain/*': ['src/domain/*'],
    });

    // Parent config sets both baseUrl and paths relative to config/.
    const infra = parseTsConfigContent(
      JSON.stringify({ extends: './config/infra-base.json' }),
      (rel) => files[rel] ?? null,
    );
    expect(infra?.baseUrl).toBe('.');
    expect(infra?.paths).toEqual({
      '@infra/*': ['src/infrastructure/*'],
    });

    const knownFiles = new Set(['src/infrastructure/repo.ts', 'src/domain/order.ts']);
    expect(
      resolveImport(
        extractImports('src/domain/service.ts', "import { Order } from '@domain/order';")
          .imports[0]!,
        'src/domain/service.ts',
        { tsconfig: nested, knownFiles },
      ).resolvedPath,
    ).toBe('src/domain/order.ts');
    expect(
      resolveImport(
        extractImports('src/domain/service.ts', "import { Repo } from '@infra/repo';").imports[0]!,
        'src/domain/service.ts',
        { tsconfig: infra, knownFiles },
      ).resolvedPath,
    ).toBe('src/infrastructure/repo.ts');

    // Single config with non-root baseUrl + paths must not double-prefix baseUrl at match time.
    const subBase = parseTsConfigContent(
      JSON.stringify({
        compilerOptions: {
          baseUrl: 'src',
          paths: {
            '@app/*': ['app/*'],
          },
        },
      }),
    );
    expect(subBase?.paths['@app/*']).toEqual(['src/app/*']);
    const { imports: subImports } = extractImports(
      'src/domain/service.ts',
      "import { UseCase } from '@app/create';",
    );
    expect(
      resolveImport(subImports[0]!, 'src/domain/service.ts', {
        tsconfig: subBase,
        knownFiles: new Set(['src/app/create.ts']),
      }).resolvedPath,
    ).toBe('src/app/create.ts');
  });

  it('selects exact match and longest-prefix tsconfig path alias regardless of declaration order', () => {
    const tsconfig = parseTsConfigContent(
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@app/*': ['src/shared/*'],
            '@app/infra/*': ['src/infrastructure/*'],
            '@app/infra/special': ['src/adapters/special.ts'],
            'a*a': ['src/overlapping/*'],
          },
        },
      }),
    );
    const knownFiles = new Set([
      'src/shared/utils/fmt.ts',
      'src/infrastructure/repo.ts',
      'src/adapters/special.ts',
    ]);
    const ctx = { tsconfig, knownFiles };
    const { imports } = extractImports(
      'src/domain/service.ts',
      [
        "import { Repo } from '@app/infra/repo';",
        "import { Special } from '@app/infra/special';",
        "import { fmt } from '@app/utils/fmt';",
        "import { short } from 'a';",
      ].join('\n'),
    );

    expect(resolveImport(imports[0]!, 'src/domain/service.ts', ctx).resolvedPath).toBe(
      'src/infrastructure/repo.ts',
    );
    expect(resolveImport(imports[1]!, 'src/domain/service.ts', ctx).resolvedPath).toBe(
      'src/adapters/special.ts',
    );
    expect(resolveImport(imports[2]!, 'src/domain/service.ts', ctx).resolvedPath).toBe(
      'src/shared/utils/fmt.ts',
    );
    expect(resolveImport(imports[3]!, 'src/domain/service.ts', ctx).resolvedPath).toBeUndefined();
    expect(resolveImport(imports[3]!, 'src/domain/service.ts', ctx).packageName).toBe('a');
  });

  it('replaces inherited tsconfig paths when a child defines compilerOptions.paths', () => {
    const baseRaw = JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@infra/*': ['src/infrastructure/*'],
        },
      },
    });
    const knownFiles = new Set(['src/infrastructure/repo.ts', 'src/shared/util.ts']);

    const childWithPaths = parseTsConfigContent(
      JSON.stringify({
        extends: './base.json',
        compilerOptions: {
          paths: {
            '@shared/*': ['src/shared/*'],
          },
        },
      }),
      (rel) => (rel === 'base.json' ? baseRaw : null),
    );
    const { imports: childImports } = extractImports(
      'src/domain/service.ts',
      ["import { Repo } from '@infra/repo';", "import { u } from '@shared/util';"].join('\n'),
    );
    const resInfra = resolveImport(childImports[0]!, 'src/domain/service.ts', {
      tsconfig: childWithPaths,
      knownFiles,
    });
    const resShared = resolveImport(childImports[1]!, 'src/domain/service.ts', {
      tsconfig: childWithPaths,
      knownFiles,
    });
    expect(resInfra.resolvedPath).toBeUndefined();
    expect(resInfra.packageName).toBe('@infra/repo');
    expect(resShared.resolvedPath).toBe('src/shared/util.ts');

    const childEmptyPaths = parseTsConfigContent(
      JSON.stringify({
        extends: './base.json',
        compilerOptions: {
          paths: {},
        },
      }),
      (rel) => (rel === 'base.json' ? baseRaw : null),
    );
    const resEmpty = resolveImport(childImports[0]!, 'src/domain/service.ts', {
      tsconfig: childEmptyPaths,
      knownFiles,
    });
    expect(resEmpty.resolvedPath).toBeUndefined();
    expect(resEmpty.packageName).toBe('@infra/repo');
  });

  it('falls back to package resolution when catch-all or alias targets do not exist in the repo tree', () => {
    const tsconfig = parseTsConfigContent(
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '*': ['src/*'],
            '@lib/*': ['src/missing/*', 'src/lib/*'],
          },
        },
      }),
    );
    const knownFiles = new Set([
      'src/domain/order.ts',
      'src/infrastructure/repo.ts',
      'src/lib/util.ts',
    ]);
    const ctx = { tsconfig, knownFiles };

    const { imports } = extractImports(
      'src/domain/order.ts',
      [
        "import express from 'express';",
        "import { Repo } from 'infrastructure/repo';",
        "import { util } from '@lib/util';",
        "import { nope } from '@lib/missing';",
      ].join('\n'),
    );

    expect(resolveImport(imports[0]!, 'src/domain/order.ts', ctx).resolvedPath).toBeUndefined();
    expect(resolveImport(imports[0]!, 'src/domain/order.ts', ctx).packageName).toBe('express');
    expect(resolveImport(imports[1]!, 'src/domain/order.ts', ctx).resolvedPath).toBe(
      'src/infrastructure/repo.ts',
    );
    expect(resolveImport(imports[2]!, 'src/domain/order.ts', ctx).resolvedPath).toBe(
      'src/lib/util.ts',
    );
    expect(resolveImport(imports[3]!, 'src/domain/order.ts', ctx).resolvedPath).toBeUndefined();
    expect(resolveImport(imports[3]!, 'src/domain/order.ts', ctx).packageName).toBe('@lib/missing');

    // Without a repo tree (API-only reviews), bare `*` never swallows external packages while explicit prefixes still resolve.
    const noTreeCtx = { tsconfig };
    expect(resolveImport(imports[0]!, 'src/domain/order.ts', noTreeCtx).packageName).toBe(
      'express',
    );
    expect(
      resolveImport(imports[0]!, 'src/domain/order.ts', noTreeCtx).resolvedPath,
    ).toBeUndefined();
    expect(resolveImport(imports[3]!, 'src/domain/order.ts', noTreeCtx).resolvedPath).toBe(
      'src/missing/missing',
    );
  });

  it('resolves C# namespaces to repo paths via namespace index and directory alignment', () => {
    const csSrc = [
      'namespace Acme.Domain;',
      'using Acme.Infrastructure;',
      'using static Acme.Infrastructure.Repository;',
      'using Microsoft.Extensions.Logging;',
    ].join('\n');

    const nestedParsed = extractImports('src/Domain/Order.cs', csSrc);
    const knownFiles = new Set(['src/Domain/Order.cs', 'src/Infrastructure/Repository.cs']);

    // Nested folder layout (`src/Domain` declaring `Acme.Domain`) resolves with and without knownFiles.
    const withFiles = resolveImport(
      nestedParsed.imports[0]!,
      'src/Domain/Order.cs',
      { knownFiles },
      nestedParsed.meta,
    );
    expect(withFiles.resolvedPath).toBe('src/Infrastructure');

    const withoutFiles = resolveImport(
      nestedParsed.imports[0]!,
      'src/Domain/Order.cs',
      {},
      nestedParsed.meta,
    );
    expect(withoutFiles.resolvedPath).toBe('src/Infrastructure');

    // `using static Ns.Type` resolves via csharpNamespaces even when file path diverges from namespace.
    const indexedStatic = resolveImport(
      nestedParsed.imports[1]!,
      'src/Domain/Order.cs',
      { csharpNamespaces: new Map([['Acme.Infrastructure', 'src/Persistence/Repository.cs']]) },
      nestedParsed.meta,
    );
    expect(indexedStatic.resolvedPath).toBe('src/Persistence/Repository.cs');

    // External framework namespaces remain package references.
    expect(
      resolveImport(
        nestedParsed.imports[2]!,
        'src/Domain/Order.cs',
        { knownFiles },
        nestedParsed.meta,
      ).packageName,
    ).toBe('Microsoft.Extensions.Logging');

    // SDK-style dotted project directory (`src/Acme.Domain/Order.cs`) maps to sibling `src/Acme.Infrastructure`.
    const dottedParsed = extractImports('src/Acme.Domain/Order.cs', csSrc);
    const dottedResolved = resolveImport(
      dottedParsed.imports[0]!,
      'src/Acme.Domain/Order.cs',
      {},
      dottedParsed.meta,
    );
    expect(dottedResolved.resolvedPath).toBe('src/Acme.Infrastructure');
  });
});
