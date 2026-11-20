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
    expect(resolved[3]?.resolvedPath).toBe('src/domain/helper.rs');
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
});
