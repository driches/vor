import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedFile } from '../types.js';
import type { ScannerDeps } from './types.js';
import { createSastScanner, sastScannerStub } from './sast.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    reviewable_lines: [[1, 5]],
    added_lines: new Set([1, 2, 3, 4, 5]),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('sast scanner (fan-out orchestrator)', () => {
  it('is tagged with the sast scanner id', () => {
    expect(createSastScanner().id).toBe('sast');
    // Back-compat export keeps the same id for the registry import path.
    expect(sastScannerStub.id).toBe('sast');
  });

  it('applies() returns true when the diff contains any file matched by a registered linter', () => {
    const scanner = createSastScanner();
    // ESLint scope
    expect(scanner.applies([makeFile({ path: 'src/foo.ts' })])).toBe(true);
    expect(scanner.applies([makeFile({ path: 'src/foo.tsx' })])).toBe(true);
    expect(scanner.applies([makeFile({ path: 'scripts/build.mjs' })])).toBe(true);
    expect(scanner.applies([makeFile({ path: 'src/app.jsx' })])).toBe(true);
    // Ruff scope
    expect(scanner.applies([makeFile({ path: 'src/foo.py' })])).toBe(true);
    expect(scanner.applies([makeFile({ path: 'src/foo.pyi' })])).toBe(true);
    // Dart scope
    expect(scanner.applies([makeFile({ path: 'lib/foo.dart' })])).toBe(true);
    // actionlint scope (only .github/workflows/*.yml)
    expect(scanner.applies([makeFile({ path: '.github/workflows/ci.yml' })])).toBe(true);
    expect(scanner.applies([makeFile({ path: '.github/workflows/release.yaml' })])).toBe(true);
  });

  it('applies() returns false for diffs no linter handles', () => {
    const scanner = createSastScanner();
    expect(scanner.applies([])).toBe(false);
    expect(scanner.applies([makeFile({ path: 'README.md' })])).toBe(false);
    expect(scanner.applies([makeFile({ path: 'requirements.txt' })])).toBe(false);
    // Generic yaml that's NOT in .github/workflows shouldn't trigger actionlint
    expect(scanner.applies([makeFile({ path: 'config.yml' })])).toBe(false);
    expect(scanner.applies([makeFile({ path: 'kustomization.yaml' })])).toBe(false);
    // Other source languages we haven't added a linter for yet
    expect(scanner.applies([makeFile({ path: 'src/foo.go' })])).toBe(false);
    expect(scanner.applies([makeFile({ path: 'src/foo.rs' })])).toBe(false);
  });

  it('applies() skips generated and binary files even when extension matches', () => {
    const scanner = createSastScanner();
    expect(
      scanner.applies([makeFile({ path: 'dist/index.js', is_generated: true })]),
    ).toBe(false);
    expect(
      scanner.applies([makeFile({ path: 'src/foo.ts', is_binary: true })]),
    ).toBe(false);
    expect(
      scanner.applies([makeFile({ path: 'lib/foo.dart', is_generated: true })]),
    ).toBe(false);
  });

  it('scan() returns an empty result quietly when no linter binaries are in the workspace', async () => {
    const scanner = createSastScanner();
    // Empty tmpdir as the "repo" — no node_modules, no .venv, etc.
    // Linters short-circuit when their binary is missing (very common for
    // repos that use other tooling); the scanner should not surface this
    // as an error.
    const tmp = mkdtempSync(join(tmpdir(), 'sast-test-'));
    try {
      const deps = {
        changedFiles: [makeFile()],
        workspaceDir: tmp,
        signal: new AbortController().signal,
      } as unknown as ScannerDeps;
      const result = await scanner.scan(deps);
      expect(result.scanner).toBe('sast');
      expect(result.findings).toEqual([]);
      // ESLint short-circuits silently when bin missing → no errors.
      // Ruff/dart/actionlint may produce ENOENT-wrapped silent skips OR
      // actual errors depending on PATH state; we tolerate both as long
      // as the scanner doesn't throw.
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scan() returns an empty result when no source-language files are in the diff', async () => {
    const scanner = createSastScanner();
    const tmp = mkdtempSync(join(tmpdir(), 'sast-test-'));
    try {
      const deps = {
        changedFiles: [makeFile({ path: 'README.md' })],
        workspaceDir: tmp,
        signal: new AbortController().signal,
      } as unknown as ScannerDeps;
      const result = await scanner.scan(deps);
      expect(result.findings).toEqual([]);
      expect(result.metrics.files_examined).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
