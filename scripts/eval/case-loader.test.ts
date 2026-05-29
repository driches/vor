import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
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
    expect(c.files.find((f) => f.path === 'src/auth.ts')?.content).toContain(
      'AKIAIOSFODNN7EXAMPLE',
    );
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

  it('throws on a truth.yml entry missing required line_range', () => {
    // Regression for PR #10 Codex P2 3295049301. Without per-entry
    // validation, scoreRun's `truth.line_range[0]` would throw a TypeError
    // at runtime instead of failing fast with a clear dataset error.
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability]',
        // line_range missing
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/line_range/);
    rmSync(dir, { recursive: true });
  });

  it('throws on a truth.yml line_range with non-integer values', () => {
    // Regression for PR #10 Codex P2 3295092576. The earlier check only
    // verified line_range was two numbers, so floats slipped through.
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [1.5, 2.5]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability]',
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/must be integers/);
    rmSync(dir, { recursive: true });
  });

  it('throws on a truth.yml line_range with zero or negative values', () => {
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [0, 0]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability]',
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/must be >= 1/);
    rmSync(dir, { recursive: true });
  });

  it('throws on a truth.yml line_range that is reversed (start > end)', () => {
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [20, 10]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability]',
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/must be ordered/);
    rmSync(dir, { recursive: true });
  });

  it('throws on a truth.yml entry with malformed category (non-array)', () => {
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [1, 1]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: vulnerability', // should be a list, got scalar
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/category.*array/);
    rmSync(dir, { recursive: true });
  });

  it('throws on a truth.yml entry with invalid severity', () => {
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts',
        '    line_range: [1, 1]',
        '    bug_type: secret:aws-access-key',
        '    severity: SUPER_CRITICAL', // not in the enum
        '    plant_id: 0',
        '    category: [vulnerability]',
      ].join('\n'),
    });
    expect(() => loadCase(dir, 'example')).toThrow(/critical\|important\|minor\|nit/);
    rmSync(dir, { recursive: true });
  });

  it('throws naming the offending entry index for a malformed truth among valid ones', () => {
    const { dir } = makeCase({
      truthYaml: [
        'truths:',
        '  - file: src/auth.ts', // valid
        '    line_range: [1, 1]',
        '    bug_type: secret:aws-access-key',
        '    severity: critical',
        '    plant_id: 0',
        '    category: [vulnerability]',
        '  - file: src/other.ts', // malformed (missing severity)
        '    line_range: [10, 10]',
        '    bug_type: secret:github-pat',
        '    plant_id: 1',
        '    category: [vulnerability]',
      ].join('\n'),
    });
    // The error must call out index [1], not [0], so the operator can locate
    // the bad entry without manual bisection.
    expect(() => loadCase(dir, 'example')).toThrow(/entry \[1\]/);
    rmSync(dir, { recursive: true });
  });

  it('rejects a caseId that escapes the golden cases/ tree (../-style)', () => {
    // Regression for PR #10 Codex P2 3295138893. The old loadCase used
    // `join(goldenRepo, 'cases', caseId)` without any validation, so
    // `--case ../other-repo/case` could read after/, before/, and truth.yml
    // from outside the golden tree.
    const root = mkdtempSync(join(tmpdir(), 'case-loader-traversal-'));
    expect(() => loadCase(root, '../escape')).toThrow(/resolves outside cases root/);
    rmSync(root, { recursive: true });
  });

  it('rejects a symlinked after/ root (refuses to follow before walk)', () => {
    // Regression for PR #10 Codex P2 3295250485. walk()'s per-entry lstatSync
    // only catches symlinks INSIDE after/; a root-level `after -> /tmp/outside`
    // symlink would have readdirSync silently follow the link. lstat the
    // root explicitly before walking.
    const root = mkdtempSync(join(tmpdir(), 'case-loader-root-symlink-'));
    const id = 'symlinked-after-root';
    const caseDir = join(root, 'cases', id);
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(join(caseDir, 'before'));
    // Set up the malicious target dir outside the case.
    const outsideAfter = mkdtempSync(join(tmpdir(), 'case-loader-outside-after-'));
    writeFileSync(join(outsideAfter, 'host-file.ts'), 'host content');
    // Symlink after/ -> outsideAfter
    symlinkSync(outsideAfter, join(caseDir, 'after'));
    writeFileSync(join(caseDir, 'truth.yml'), 'truths: []\n');
    expect(() => loadCase(root, id)).toThrow(/symlinked after\/ root/);
    rmSync(outsideAfter, { recursive: true });
    rmSync(root, { recursive: true });
  });

  it('rejects a symlinked before/ root', () => {
    // Same gap as the after/ test above but on the before/ side.
    const root = mkdtempSync(join(tmpdir(), 'case-loader-before-root-symlink-'));
    const id = 'symlinked-before-root';
    const caseDir = join(root, 'cases', id);
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(join(caseDir, 'after'));
    const outsideBefore = mkdtempSync(join(tmpdir(), 'case-loader-outside-before-'));
    writeFileSync(join(outsideBefore, 'host-file.ts'), 'host content');
    symlinkSync(outsideBefore, join(caseDir, 'before'));
    writeFileSync(join(caseDir, 'truth.yml'), 'truths: []\n');
    expect(() => loadCase(root, id)).toThrow(/symlinked before\/ root/);
    rmSync(outsideBefore, { recursive: true });
    rmSync(root, { recursive: true });
  });

  it('rejects a symlinked file inside after/ (refuses to follow during walk)', () => {
    // Regression for PR #10 Codex P2 3295138894. walk() previously used
    // statSync, which follows symlinks. A symlinked file inside after/ or
    // before/ would pull external content into LoadedCase.files[]; a cycle
    // like `loop -> ..` would recurse indefinitely.
    const root = mkdtempSync(join(tmpdir(), 'case-loader-symlink-'));
    const id = 'with-symlink';
    const caseDir = join(root, 'cases', id);
    mkdirSync(join(caseDir, 'after'), { recursive: true });
    mkdirSync(join(caseDir, 'before'), { recursive: true });
    writeFileSync(join(caseDir, 'after/legit.ts'), '// legit\n');
    writeFileSync(join(caseDir, 'before/legit.ts'), '// legit\n');
    writeFileSync(join(caseDir, 'truth.yml'), 'truths: []\n');
    // Plant a symlink in after/ pointing at an outside-tree sentinel file.
    const outsideTarget = mkdtempSync(join(tmpdir(), 'case-loader-symlink-target-'));
    writeFileSync(join(outsideTarget, 'host.txt'), 'host content');
    symlinkSync(join(outsideTarget, 'host.txt'), join(caseDir, 'after/leaky-link'));
    expect(() => loadCase(root, id)).toThrow(/refusing to traverse symlink/);
    rmSync(outsideTarget, { recursive: true });
    rmSync(root, { recursive: true });
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
    expect(c1.beforeFiles.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    rmSync(root, { recursive: true });
  });
});
