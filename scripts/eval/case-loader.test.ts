import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCase } from './case-loader.js';

function makeCase(): { dir: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), 'case-loader-test-'));
  const id = 'example';
  const caseDir = join(root, 'cases', id);
  mkdirSync(join(caseDir, 'after/src'), { recursive: true });
  writeFileSync(join(caseDir, 'after/src/auth.ts'), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
  writeFileSync(
    join(caseDir, 'truth.yml'),
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
  it('reads after/ files and truth.yml from a case directory', () => {
    const { dir, id } = makeCase();
    const c = loadCase(dir, id);
    expect(c.case_id).toBe('example');
    expect(c.files.find((f) => f.path === 'src/auth.ts')?.content).toContain('AKIAIOSFODNN7EXAMPLE');
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
    expect(() => loadCase(root, 'no-truth')).toThrow(/truth\.yml/);
    rmSync(root, { recursive: true });
  });
});
