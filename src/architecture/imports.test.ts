import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectArchLanguage,
  extractImports,
  extractKotlinDeclarations,
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

  it('extracts top-level Kotlin declarations and resolves Kotlin symbols to declaring files', () => {
    const kotlinEntry = [
      'package com.acme.modules.orders',
      'import com.acme.modules.shared.Money',
      '',
      '/* fun commentedOut() {} */',
      'const val DEFAULT_CURRENCY = "USD"',
      'typealias OrderId = String',
      'data class Order(val id: OrderId, var status: String = "fun fakeVal() {}") {',
      '  fun memberIgnored() {}',
      '}',
      'sealed interface OrderEvent',
      'fun interface OrderValidator { fun validate(id: String): Boolean }',
      'object OrderFactory {',
      '  fun create(): Order = Order("1")',
      '}',
      'val Order.isValid: Boolean get() = true',
      'suspend fun <T : Any> List<T>.mapOrders(fn: (T) -> Unit) {',
      '  val localVal = 1',
      '  fun localFun() {}',
      '  forEach(fn)',
      '}',
      'fun placeOrder(id: OrderId): Order {',
      '  return Order(id)',
      '}',
      'val anonObj = object : OrderValidator {',
      '  override fun validate(id: String) = true',
      '}',
    ].join('\n');

    const decl = extractKotlinDeclarations(kotlinEntry);
    expect(decl.packageName).toBe('com.acme.modules.orders');
    expect(decl.symbols.sort()).toEqual([
      'DEFAULT_CURRENCY',
      'Order',
      'OrderEvent',
      'OrderFactory',
      'OrderId',
      'OrderValidator',
      'anonObj',
      'isValid',
      'mapOrders',
      'placeOrder',
    ]);
    expect(decl.symbols).not.toContain('commentedOut');
    expect(decl.symbols).not.toContain('memberIgnored');
    expect(decl.symbols).not.toContain('localVal');
    expect(decl.symbols).not.toContain('localFun');
    expect(decl.symbols).not.toContain('id');
    expect(decl.symbols).not.toContain('status');
    expect(decl.symbols).not.toContain('interface');

    const billingSrc = [
      'package com.acme.modules.billing',
      'import com.acme.modules.orders.placeOrder',
      'import com.acme.modules.orders.OrderFactory.create',
      'import kotlin.collections.List',
    ].join('\n');
    const parsed = extractImports(
      'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
      billingSrc,
    );
    const ctx = {
      knownFiles: new Set([
        'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
        'src/main/kotlin/com/acme/modules/orders/index.kt',
      ]),
      kotlinSymbols: new Map([
        ['com.acme.modules.orders.placeOrder', 'src/main/kotlin/com/acme/modules/orders/index.kt'],
        [
          'com.acme.modules.orders.OrderFactory',
          'src/main/kotlin/com/acme/modules/orders/index.kt',
        ],
      ]),
    };

    const resolvedFn = resolveImport(
      parsed.imports[0]!,
      'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
      ctx,
      parsed.meta,
    );
    expect(resolvedFn.resolvedPath).toBe('src/main/kotlin/com/acme/modules/orders/index.kt');

    const resolvedNested = resolveImport(
      parsed.imports[1]!,
      'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
      ctx,
      parsed.meta,
    );
    expect(resolvedNested.resolvedPath).toBe('src/main/kotlin/com/acme/modules/orders/index.kt');

    const resolvedStdlib = resolveImport(
      parsed.imports[2]!,
      'src/main/kotlin/com/acme/modules/billing/BillingService.kt',
      ctx,
      parsed.meta,
    );
    expect(resolvedStdlib.packageName).toBe('kotlin.collections.List');
  });

  it('resolves multi-module Java imports across separate repository source roots', () => {
    const srcPath = 'modules/billing/src/main/java/com/acme/billing/Service.java';
    const src = [
      'package com.acme.billing;',
      'import com.acme.orders.Order;',
      'import com.acme.orders.Order.Builder;',
      'import com.acme.orders.*;',
    ].join('\n');

    const parsed = extractImports(srcPath, src);
    const knownFiles = new Set([
      srcPath,
      'modules/orders/src/main/java/com/acme/orders/Order.java',
    ]);
    const ctx = { knownFiles };

    expect(resolveImport(parsed.imports[0]!, srcPath, ctx, parsed.meta).resolvedPath).toBe(
      'modules/orders/src/main/java/com/acme/orders/Order.java',
    );
    expect(resolveImport(parsed.imports[1]!, srcPath, ctx, parsed.meta).resolvedPath).toBe(
      'modules/orders/src/main/java/com/acme/orders/Order.java',
    );
    expect(resolveImport(parsed.imports[2]!, srcPath, ctx, parsed.meta).resolvedPath).toBe(
      'modules/orders/src/main/java/com/acme/orders',
    );
  });

  it('excludes member-access and $-prefixed require/import calls while keeping spread require and dynamic import', () => {
    const src = [
      "parser.require('express');",
      "parser?.require('express');",
      "parser.\n  require('express');",
      "obj.import('express');",
      "obj?.import('express');",
      "this.#require('express');",
      "$require('express');",
      "$import('express');",
      "const a = require('express');",
      "const b = { ...require('./spread') };",
      "const c = await import('./dynamic');",
    ].join('\n');

    const { imports } = extractImports('src/domain/order.ts', src);
    expect(imports.map((i) => i.specifier)).toEqual(['express', './spread', './dynamic']);
    expect(imports.map((i) => i.line)).toEqual([10, 11, 12]);
  });

  it('extracts Dart conditional import and export branch URIs with individual line numbers', () => {
    const dartSrc = [
      "import '../shared/repo.dart' if (dart.library.io) '../infrastructure/repo.dart';",
      "export '../shared/stub.dart' // default stub",
      "  if (dart.library.io == 'true') '../infrastructure/io_repo.dart'",
      "  if (dart.library.html) r'../infrastructure/web_repo.dart'",
      '  show OrderRepo;',
      "part 'order_part.dart';",
    ].join('\n');

    const parsed = extractImports('lib/domain/order.dart', dartSrc);
    expect(parsed.imports.map((i) => [i.specifier, i.line])).toEqual([
      ['../shared/repo.dart', 1],
      ['../infrastructure/repo.dart', 1],
      ['../shared/stub.dart', 2],
      ['../infrastructure/io_repo.dart', 3],
      ['../infrastructure/web_repo.dart', 4],
      ['order_part.dart', 6],
    ]);

    const resolved = resolveImports(parsed.imports, 'lib/domain/order.dart', {
      dartPackage: 'sample_app',
      knownFiles: new Set(['lib/shared/repo.dart', 'lib/infrastructure/repo.dart']),
    });
    expect(resolved[1]?.resolvedPath).toBe('lib/infrastructure/repo.dart');
  });

  it('tracks nested block comments in Rust, Dart, and Kotlin while closing C-style comments on first end marker', () => {
    const rustSrc = [
      '/* outer comment',
      ' /* nested comment */',
      ' use sqlx::Pool;',
      '*/',
      'use crate::domain::Order;',
    ].join('\n');
    expect(extractImports('src/domain/order.rs', rustSrc).imports.map((i) => i.specifier)).toEqual([
      'crate::domain::Order',
    ]);

    const dartSrc = [
      '/* outer',
      ' /* inner */',
      " import '../infrastructure/db.dart';",
      '*/',
      "import '../domain/money.dart';",
    ].join('\n');
    expect(
      extractImports('lib/domain/order.dart', dartSrc).imports.map((i) => i.specifier),
    ).toEqual(['../domain/money.dart']);

    const ktSrc = [
      'package com.acme.billing',
      '/* outer',
      ' /* inner */',
      ' import com.acme.orders.secret',
      '*/',
      'import com.acme.shared.Money',
    ].join('\n');
    expect(
      extractImports('src/main/kotlin/com/acme/billing/Bill.kt', ktSrc).imports.map(
        (i) => i.specifier,
      ),
    ).toEqual(['com.acme.shared.Money']);

    const javaSrc = ['package com.acme;', '/* outer /* inner */ import com.acme.Real;', '*/'].join(
      '\n',
    );
    expect(
      extractImports('src/main/java/com/acme/A.java', javaSrc).imports.map((i) => i.specifier),
    ).toEqual(['com.acme.Real']);
  });

  it('extracts and resolves global::-qualified C# using directives', () => {
    const csSrc = [
      'namespace Acme.Domain;',
      'using global::Acme.infrastructure;',
      'global using global::Acme.Infrastructure.Events;',
      'using static global::Acme.Infrastructure.Repo;',
      'using InfraAlias = global::Acme.Infrastructure.Repo;',
    ].join('\n');

    const parsed = extractImports('src/domain/Order.cs', csSrc);
    expect(parsed.imports.map((i) => [i.specifier, i.line])).toEqual([
      ['Acme.infrastructure', 2],
      ['Acme.Infrastructure.Events', 3],
      ['Acme.Infrastructure.Repo', 4],
      ['Acme.Infrastructure.Repo', 5],
    ]);

    const resolved = resolveImports(
      parsed.imports,
      'src/domain/Order.cs',
      {
        knownFiles: new Set(['src/domain/Order.cs', 'src/infrastructure/Repo.cs']),
        csharpNamespaces: new Map([
          ['Acme.infrastructure', 'src/infrastructure'],
          ['Acme.Infrastructure.Repo', 'src/infrastructure'],
        ]),
      },
      parsed.meta,
    );
    expect(resolved[0]?.resolvedPath).toBe('src/infrastructure');
    expect(resolved[2]?.resolvedPath).toBe('src/infrastructure');
  });

  it('normalizes leading :: qualifiers on Rust imports so external crate names resolve consistently', () => {
    const rustSrc = [
      'use ::sqlx::Pool;',
      'use ::serde::{Deserialize, Serialize};',
      'use ::{tokio::spawn};',
    ].join('\n');

    const parsed = extractImports('src/domain/order.rs', rustSrc);
    expect(parsed.imports.map((i) => i.specifier)).toEqual([
      'sqlx::Pool',
      'serde::Deserialize',
      'serde::Serialize',
      'tokio::spawn',
    ]);

    const resolved = resolveImports(parsed.imports, 'src/domain/order.rs', {}, parsed.meta);
    expect(resolved.map((r) => r.packageName)).toEqual(['sqlx', 'serde', 'serde', 'tokio']);

    // Direct resolveImport calls with an un-normalized leading `::` also resolve the crate name.
    const direct = resolveImport(
      {
        specifier: '::sqlx::Pool',
        line: 1,
        snippet: 'use ::sqlx::Pool;',
        language: 'rust',
        kindHint: 'package',
      },
      'src/domain/order.rs',
      {},
      {},
    );
    expect(direct.packageName).toBe('sqlx');
  });

  it('extracts static no-substitution template literals in JS/TS require and import calls while skipping dynamic templates', () => {
    const tsSrc = [
      'const db = require(`pg`);',
      'const mod = await import(`express`);',
      'const infra = await import(`../infrastructure/db`);',
      'const dyn = await import(`./drivers/${name}`);',
      'const dynReq = require(`./${dir}/pg`);',
      'const tagged = require(tag`pg`);',
    ].join('\n');

    const parsed = extractImports('src/domain/order.ts', tsSrc);
    expect(parsed.imports.map((i) => [i.specifier, i.line])).toEqual([
      ['pg', 1],
      ['express', 2],
      ['../infrastructure/db', 3],
    ]);

    const resolved = resolveImports(
      parsed.imports,
      'src/domain/order.ts',
      { knownFiles: new Set(['src/domain/order.ts', 'src/infrastructure/db.ts']) },
      parsed.meta,
    );
    expect(resolved).toEqual([
      expect.objectContaining({ specifier: 'pg', packageName: 'pg' }),
      expect.objectContaining({ specifier: 'express', packageName: 'express' }),
      expect.objectContaining({
        specifier: '../infrastructure/db',
        resolvedPath: 'src/infrastructure/db.ts',
      }),
    ]);
  });

  it('ignores Python imports inside backslash-continued single- and double-quoted strings', () => {
    const pySrc = [
      'EXAMPLE_LF = "line 1 \\',
      'from flask import Flask\\',
      'import requests"',
      "EXAMPLE_CRLF = 'line 1 \\\r",
      "from fastapi import FastAPI'\r",
      'from ..infra.db import Repo',
    ].join('\n');

    const parsed = extractImports('app/domain/service.py', pySrc);
    expect(parsed.imports).toHaveLength(1);
    expect(parsed.imports[0]?.specifier).toBe('..infra.db');
    expect(parsed.imports[0]?.line).toBe(6);
  });

  it('ignores C# multiline verbatim strings with doubled quotes and trailing backslashes', () => {
    const csSrc = [
      'public class Examples {',
      '  public string Ex1 = @"',
      'using Dapper;',
      '""escaped""',
      'namespace Fake.Ns;',
      '";',
      '  public string Ex2 = $@"',
      'using Newtonsoft.Json;',
      '";',
      '  public string Ex3 = @$"',
      'using Npgsql;',
      '";',
      '  public string PathTail = @"C:\\dir\\";',
      '}',
      'namespace Acme.Domain;',
      'using Acme.Real;',
    ].join('\n');

    const parsed = extractImports('src/domain/Order.cs', csSrc);
    expect(parsed.meta.declaredPackage).toBe('Acme.Domain');
    expect(parsed.imports.map((i) => i.specifier)).toEqual(['Acme.Real']);
  });

  it('resolves package-local tsconfig.json aliases without inheriting across sibling/empty project boundaries', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-pkg-tsconfig-'));
    try {
      mkdirSync(join(ws, 'src/adapters'), { recursive: true });
      mkdirSync(join(ws, 'packages/app/src/domain'), { recursive: true });
      mkdirSync(join(ws, 'packages/app/src/adapters'), { recursive: true });
      mkdirSync(join(ws, 'packages/bare/src'), { recursive: true });
      mkdirSync(join(ws, 'packages/plain/src'), { recursive: true });

      writeFileSync(
        join(ws, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@root/*': ['src/*'] },
          },
        }),
      );
      writeFileSync(join(ws, 'src/adapters/root_repo.ts'), 'export const rootRepo = 1;\n');
      writeFileSync(
        join(ws, 'packages/app/tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: 'src',
            paths: { '@app/*': ['*'] },
          },
        }),
      );
      writeFileSync(
        join(ws, 'packages/app/tsconfig.json'),
        JSON.stringify({ extends: './tsconfig.base.json' }),
      );
      writeFileSync(
        join(ws, 'packages/app/src/adapters/app_repo.ts'),
        'export const appRepo = 1;\n',
      );
      writeFileSync(
        join(ws, 'packages/bare/tsconfig.json'),
        JSON.stringify({ compilerOptions: {} }),
      );

      const ctx = loadWorkspaceResolveContext(ws);
      const appPath = 'packages/app/src/domain/order.ts';
      const appSrc = "import { appRepo } from '@app/adapters/app_repo';\n";
      const [appResolved] = resolveImports(extractImports(appPath, appSrc).imports, appPath, ctx);
      expect(appResolved?.resolvedPath).toBe('packages/app/src/adapters/app_repo.ts');

      // An empty package-local tsconfig stops upward inheritance from root tsconfig.
      const barePath = 'packages/bare/src/index.ts';
      const bareSrc = "import { rootRepo } from '@root/adapters/root_repo';\n";
      const [bareResolved] = resolveImports(
        extractImports(barePath, bareSrc).imports,
        barePath,
        ctx,
      );
      expect(bareResolved?.resolvedPath).toBeUndefined();
      expect(bareResolved?.packageName).toBe('@root/adapters');

      // A package without its own tsconfig falls back to the root tsconfig.
      const plainPath = 'packages/plain/src/index.ts';
      const [plainResolved] = resolveImports(
        extractImports(plainPath, bareSrc).imports,
        plainPath,
        ctx,
      );
      expect(plainResolved?.resolvedPath).toBe('src/adapters/root_repo.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves nested Go modules and Dart pubspec packages per source file without inheriting across empty boundaries', () => {
    expect(parseGoModModule('module "example.com/quoted"\ngo 1.22\n')).toBe('example.com/quoted');

    const ws = mkdtempSync(join(tmpdir(), 'vor-nested-go-dart-'));
    try {
      mkdirSync(join(ws, 'services/orders/domain'), { recursive: true });
      mkdirSync(join(ws, 'services/orders/infrastructure'), { recursive: true });
      mkdirSync(join(ws, 'services/bare/domain'), { recursive: true });
      mkdirSync(join(ws, 'services/plain/domain'), { recursive: true });
      mkdirSync(join(ws, 'packages/billing/lib/domain'), { recursive: true });
      mkdirSync(join(ws, 'packages/bare_dart/lib/domain'), { recursive: true });

      writeFileSync(join(ws, 'go.mod'), 'module example.com/root\ngo 1.22\n');
      writeFileSync(join(ws, 'services/orders/go.mod'), 'module "example.com/orders"\ngo 1.22\n');
      writeFileSync(join(ws, 'services/bare/go.mod'), '// empty go.mod boundary\n');
      writeFileSync(join(ws, 'pubspec.yaml'), 'name: root_pkg\n');
      writeFileSync(join(ws, 'packages/billing/pubspec.yaml'), 'name: billing_pkg\n');
      writeFileSync(join(ws, 'packages/bare_dart/pubspec.yaml'), '# empty pubspec boundary\n');

      const ctx = loadWorkspaceResolveContext(ws);

      const goOrderPath = 'services/orders/domain/order.go';
      const [goOrderImp] = resolveImports(
        extractImports(goOrderPath, 'package domain\nimport "example.com/orders/infrastructure"\n')
          .imports,
        goOrderPath,
        ctx,
      );
      expect(goOrderImp?.resolvedPath).toBe('services/orders/infrastructure');

      // Empty services/bare/go.mod blocks inheritance from root go.mod.
      const goBarePath = 'services/bare/domain/order.go';
      const [goBareImp] = resolveImports(
        extractImports(goBarePath, 'package domain\nimport "example.com/root/infra"\n').imports,
        goBarePath,
        ctx,
      );
      expect(goBareImp?.resolvedPath).toBeUndefined();
      expect(goBareImp?.packageName).toBe('example.com/root/infra');

      // Subdirectory without go.mod falls back to root go.mod.
      const goPlainPath = 'services/plain/domain/order.go';
      const [goPlainImp] = resolveImports(
        extractImports(goPlainPath, 'package domain\nimport "example.com/root/infra"\n').imports,
        goPlainPath,
        ctx,
      );
      expect(goPlainImp?.resolvedPath).toBe('infra');

      const dartOrderPath = 'packages/billing/lib/domain/invoice.dart';
      const [dartOrderImp] = resolveImports(
        extractImports(dartOrderPath, "import 'package:billing_pkg/infra/db.dart';\n").imports,
        dartOrderPath,
        ctx,
      );
      expect(dartOrderImp?.resolvedPath).toBe('packages/billing/lib/infra/db.dart');

      const dartBarePath = 'packages/bare_dart/lib/domain/invoice.dart';
      const [dartBareImp] = resolveImports(
        extractImports(dartBarePath, "import 'package:root_pkg/infra/db.dart';\n").imports,
        dartBarePath,
        ctx,
      );
      expect(dartBareImp?.resolvedPath).toBeUndefined();
      expect(dartBareImp?.packageName).toBe('root_pkg');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('extracts continued Python imports across LF/CRLF lines and semicolons with accurate physical line numbers', () => {
    const pyLf = ['import os, \\', '    flask', 's = "; import fake"'].join('\n');
    const parsedLf = extractImports('app/domain/service.py', pyLf);
    expect(parsedLf.imports.map((i) => ({ specifier: i.specifier, line: i.line }))).toEqual([
      { specifier: 'os', line: 1 },
      { specifier: 'flask', line: 2 },
    ]);

    const pyCrlf = 'import os, \\\r\nflask\r\n';
    const parsedCrlf = extractImports('app/domain/service.py', pyCrlf);
    expect(parsedCrlf.imports.map((i) => ({ specifier: i.specifier, line: 2 }))).toBeTruthy();
    expect(parsedCrlf.imports.map((i) => ({ specifier: i.specifier, line: i.line }))).toEqual([
      { specifier: 'os', line: 1 },
      { specifier: 'flask', line: 2 },
    ]);

    const pyLeadingCont = ['import \\', '    os as o, \\', '    sqlalchemy.orm as sa'].join('\n');
    const parsedLeading = extractImports('app/domain/service.py', pyLeadingCont);
    expect(parsedLeading.imports.map((i) => ({ specifier: i.specifier, line: i.line }))).toEqual([
      { specifier: 'os', line: 2 },
      { specifier: 'sqlalchemy.orm', line: 3 },
    ]);

    const pyFromCont = ['from app.infra \\', '    import repo, \\', '    client'].join('\n');
    const parsedFrom = extractImports('app/domain/service.py', pyFromCont);
    expect(parsedFrom.imports).toHaveLength(1);
    expect(parsedFrom.imports[0]?.specifier).toBe('app.infra');
    expect(parsedFrom.imports[0]?.line).toBe(1);
    expect(parsedFrom.imports[0]?.importedNames).toEqual([
      { name: 'repo', line: 2 },
      { name: 'client', line: 3 },
    ]);

    const pySemi = 'from app.domain import foo; import flask\n';
    const parsedSemi = extractImports('app/domain/service.py', pySemi);
    expect(parsedSemi.imports.map((i) => i.specifier)).toEqual(['app.domain', 'flask']);
  });

  it('tracks enclosing inline Rust mod scopes when resolving self/super and nested mod declarations', () => {
    const knownFiles = new Set([
      'src/domain/order.rs',
      'src/domain/infrastructure.rs',
      'src/domain/order/child/sub.rs',
      'src/domain/order/child/helper.rs',
      'src/infrastructure/mod.rs',
    ]);
    const ctx = { knownFiles };
    const rsSrc = [
      'mod child {',
      "  const BRACE: char = '{';",
      '  mod sub;',
      '  use super::Order;',
      '  use self::helper::Foo;',
      '  use super::super::infrastructure::Repo;',
      '  mod inner {',
      '    use super::super::super::super::infrastructure::Repo;',
      '  }',
      '}',
    ].join('\n');

    const extracted = extractImports('src/domain/order.rs', rsSrc);
    const resolved = resolveImports(extracted.imports, 'src/domain/order.rs', ctx);
    expect(resolved.map((r) => ({ spec: r.specifier, path: r.resolvedPath }))).toEqual([
      { spec: 'super::Order', path: 'src/domain/order.rs' },
      { spec: 'self::helper::Foo', path: 'src/domain/order/child/helper.rs' },
      { spec: 'super::super::infrastructure::Repo', path: 'src/domain/infrastructure.rs' },
      {
        spec: 'super::super::super::super::infrastructure::Repo',
        path: 'src/infrastructure/mod.rs',
      },
      { spec: 'mod:sub', path: 'src/domain/order/child/sub.rs' },
    ]);
  });
});
