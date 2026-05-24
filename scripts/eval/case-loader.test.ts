import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCase } from './case-loader.js';

function makeCase(opts: { truthYaml?: string } = {}): { dir: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
  const id = 'example';
  const caseDir = join(root, 'cases', id);
  mkdirSync(join(caseDir, 'after/src'), { recursive: true });
  mkdirSync(join(caseDir, 'before/src'), { recursive: true });
  writeFileSync(join(caseDir, 'after/src/auth.ts'), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
  writeFileSync(join(caseDir, 'before/src/auth.ts'), '// empty\n');
  writeFileSync(
    join(caseDir, 'truth.yml'),
    opts.truthYaml ??
      [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [1, 1]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability, security]',
      ].join('\n'),
  );
  return { dir: root, id };
}

describe('loadCase', () => {
  it('reads after/ files, before/ files, and truth.yml from a case directory', () => {
    const { dir, id } = makeCase();
    const c = loadCase(dir, id);
    expect(c.case_id).toBe('example');
    expect(c.files.find((f) => f.path === 'src/auth.ts')?.content).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(c.beforeFiles.find((f) => f.path === 'src/auth.ts')?.content).toContain('// empty');
    expect(c.beforeFiles.length).toBeGreaterThan(0);
    expect(c.truths).toHaveLength(1);
    expect(c.truths[0]!.bug_type).toBe('secret:aws-access-key');
    rmSync(dir, { recursive: true });
  });

  it('throws when the case dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    expect(() => loadCase(root, 'nonexistent')).toThrow(/cases.nonexistent/);
    rmSync(root, { recursive: true });
  });

  it('throws when truth.yml is missing (case not planted yet)', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    mkdirSync(join(root, 'cases', 'no-truth', 'after'), { recursive: true });
    mkdirSync(join(root, 'cases', 'no-truth', 'before'), { recursive: true });
    expect(() => loadCase(root, 'no-truth')).toThrow(/truth\.yml/);
    rmSync(root, { recursive: true });
  });

  it('throws when before/ snapshot is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    const caseDir = join(root, 'cases', 'no-before');
    mkdirSync(join(caseDir, 'after'), { recursive: true });
    writeFileSync(join(caseDir, 'truth.yml'), 'truths: []\n');
    expect(() => loadCase(root, 'no-before')).toThrow(/before\/ snapshot/);
    rmSync(root, { recursive: true });
  });

  it('throws when truth.yml has the wrong top-level key (missing truths:)', () => {
    // Regression for PR #10 comment 3294950627. Previously a malformed
    // truth.yml silently parsed to `{ truths: [] }`, and scoreRun then
    // reported recall=1.0 (perfect!) on a case with zero ground truth.
    const { dir } = makeCase({ truthYaml: 'not_truths: []\n' });
    expect(() => loadCase(dir, 'example')).toThrow(/truth\.yml is malformed/);
    rmSync(dir, { recursive: true });
  });

  it('throws when truth.yml truths is not an array (wrong shape)', () => {
    const { dir } = makeCase({ truthYaml: 'truths: "not an array"\n' });
    expect(() => loadCase(dir, 'example')).toThrow(/must be an array/);
    rmSync(dir, { recursive: true });
  });

  it('returns files in deterministic lexicographic order across runs', () => {
    // Regression for PR #10 Codex P2 3295006721. Raw readdirSync order is
    // filesystem-dependent; without sorting, multi-file cases would
    // produce different diffs/file lists across machines or even across
    // runs on the same machine, introducing eval variance unrelated to
    // model quality.
    const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
    const id = 'multi';
    const caseDir = join(root, 'cases', id);
    mkdirSync(join(caseDir, 'after/src'), { recursive: true });
    mkdirSync(join(caseDir, 'before/src'), { recursive: true });
    // Create files in an order that filesystem traversal would NOT
    // necessarily preserve (z first, then a, then b).
    for (const name of ['z.ts', 'a.ts', 'b.ts']) {
      writeFileSync(join(caseDir, 'after/src', name), `// ${name}\n`);
      writeFileSync(join(caseDir, 'before/src', name), '// empty\n');
    }
    writeFileSync(join(caseDir, 'truth.yml'), 'truths: []\n');

    const c1 = loadCase(root, id);
    const c2 = loadCase(root, id);
    const paths1 = c1.files.map((f) => f.path);
    const paths2 = c2.files.map((f) => f.path);
    expect(paths1).toEqual(paths2);
    // And the order is the sorted one.
    expect(paths1).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);

    // beforeFiles must also be sorted.
    expect(c1.beforeFiles.map((f) => f.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/z.ts',
    ]);
    rmSync(root, { recursive: true });
  });
});
