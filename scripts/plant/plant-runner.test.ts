import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runPlants } from './plant-runner.js';

function makeCase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plant-runner-test-'));
  mkdirSync(join(dir, 'before/src/config'), { recursive: true });
  writeFileSync(join(dir, 'before/src/config/aws.ts'), 'export const config = {\n  // body\n};\n');
  writeFileSync(
    join(dir, 'before/package-lock.json'),
    JSON.stringify(
      { name: 'test', lockfileVersion: 3, packages: { '': { name: 'test', version: '1.0.0' } } },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

describe('runPlants', () => {
  it('applies plants in order, writes after/ + truth.yml', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 2',
        '  - type: vuln-dep:npm',
        '    file: package-lock.json',
        '    package: lodash',
        '    version: "4.17.20"',
      ].join('\n'),
    );

    await runPlants(caseDir);

    expect(existsSync(join(caseDir, 'after'))).toBe(true);
    const mutatedAws = readFileSync(join(caseDir, 'after/src/config/aws.ts'), 'utf-8');
    expect(mutatedAws).toContain('AKIAIOSFODNN7EXAMPLE');
    const mutatedLock = readFileSync(join(caseDir, 'after/package-lock.json'), 'utf-8');
    expect(JSON.parse(mutatedLock).packages['node_modules/lodash']).toEqual({ version: '4.17.20' });

    const truthRaw = readFileSync(join(caseDir, 'truth.yml'), 'utf-8');
    const truth = parseYaml(truthRaw) as { truths: Array<Record<string, unknown>> };
    expect(truth.truths).toHaveLength(2);
    expect(truth.truths[0]!.bug_type).toBe('secret:aws-access-key');
    expect(truth.truths[0]!.plant_id).toBe(0);
    expect(truth.truths[1]!.bug_type).toBe('vuln-dep:npm:lodash@4.17.20');
    expect(truth.truths[1]!.plant_id).toBe(1);

    rmSync(caseDir, { recursive: true });
  });

  it('throws when plants.yml is missing', async () => {
    const caseDir = makeCase();
    await expect(runPlants(caseDir)).rejects.toThrow(/plants\.yml/);
    rmSync(caseDir, { recursive: true });
  });

  it('throws when a plant references a file outside before/', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/does-not-exist.ts',
        '    line: 1',
      ].join('\n'),
    );
    await expect(runPlants(caseDir)).rejects.toThrow(/does-not-exist/);
    rmSync(caseDir, { recursive: true });
  });

  it('subsequent plants on the same file see the post-previous state', async () => {
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 1',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 1',
      ].join('\n'),
    );
    await runPlants(caseDir);
    const mutated = readFileSync(join(caseDir, 'after/src/config/aws.ts'), 'utf-8');
    const occurrences = mutated.split('AKIAIOSFODNN7EXAMPLE').length - 1;
    expect(occurrences).toBe(2);
    rmSync(caseDir, { recursive: true });
  });

  it('clears after/ between runs so stale files from a prior plant do not leak in', async () => {
    // Regression for PR #10 comment 3294902774. Iterating on plants.yml used
    // to leave behind files that a previous run created.
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 2',
      ].join('\n'),
    );
    await runPlants(caseDir);
    // Author manually adds a stale file directly into after/ — could equally
    // be a file the previous plants.yml referenced but the new one does not.
    writeFileSync(join(caseDir, 'after/stale.txt'), 'leftover');
    expect(existsSync(join(caseDir, 'after/stale.txt'))).toBe(true);

    await runPlants(caseDir);
    expect(existsSync(join(caseDir, 'after/stale.txt'))).toBe(false);
    // And the legit content is still there post-replant.
    const mutated = readFileSync(join(caseDir, 'after/src/config/aws.ts'), 'utf-8');
    expect(mutated).toContain('AKIAIOSFODNN7EXAMPLE');
    rmSync(caseDir, { recursive: true });
  });

  it('rejects a symlinked before/ root (refuses to follow before copyTree)', async () => {
    // Regression for PR #10 Codex P2 3295250486. copyTree's per-entry
    // lstatSync only catches symlinks INSIDE before/; a root-level
    // `before/ -> /tmp/outside` symlink would have readdirSync follow the
    // link and copy arbitrary external directories into after/. lstat the
    // root before copying.
    const root = mkdtempSync(join(tmpdir(), 'plant-runner-root-symlink-'));
    const caseDir = join(root, 'cases', 'x');
    mkdirSync(caseDir, { recursive: true });
    // Outside target with a sentinel file.
    const outsideTarget = mkdtempSync(join(tmpdir(), 'plant-runner-outside-target-'));
    writeFileSync(join(outsideTarget, 'host.txt'), 'host content');
    // before/ is a symlink to the outside dir.
    symlinkSync(outsideTarget, join(caseDir, 'before'));
    writeFileSync(
      join(caseDir, 'plants.yml'),
      ['plants:', '  - type: secret:aws-access-key', '    file: x.ts', '    line: 1'].join('\n'),
    );
    await expect(runPlants(caseDir)).rejects.toThrow(/symlinked before\/ root/);
    // The host content must NOT have been copied into after/.
    expect(existsSync(join(caseDir, 'after/host.txt'))).toBe(false);
    rmSync(outsideTarget, { recursive: true });
    rmSync(root, { recursive: true });
  });

  it('rejects a symlink entry in before/ (refuses to follow during copyTree)', async () => {
    // Regression for PR #10 Codex P2 3295129340. copyTree previously used
    // statSync, which follows symlinks. A symlinked directory in before/
    // would silently pull external files into after/, and a cycle like
    // `loop -> ..` would recurse indefinitely. Now lstatSync detects the
    // symlink and throws — eval cases must be self-contained.
    const caseDir = makeCase();
    // Plant a symlink in before/ pointing somewhere outside the case.
    const outsideTarget = mkdtempSync(join(tmpdir(), 'plant-runner-symlink-target-'));
    writeFileSync(join(outsideTarget, 'sensitive.txt'), 'host file content');
    symlinkSync(outsideTarget, join(caseDir, 'before/leaky-link'));
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: src/config/aws.ts',
        '    line: 2',
      ].join('\n'),
    );
    await expect(runPlants(caseDir)).rejects.toThrow(/refusing to copy symlink/);
    // Sensitive file in the symlink target must NOT have been copied into after/.
    expect(existsSync(join(caseDir, 'after/leaky-link/sensitive.txt'))).toBe(false);
    rmSync(outsideTarget, { recursive: true });
    rmSync(caseDir, { recursive: true });
  });

  it('rejects a plant.file path that escapes the case directory', async () => {
    // Regression for PR #10 comment 3294915016. A malicious or buggy
    // plants.yml must not be able to write outside the case via `..`.
    const caseDir = makeCase();
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        '  - type: secret:aws-access-key',
        '    file: ../../../tmp/escaped-target.ts',
        '    line: 1',
      ].join('\n'),
    );
    await expect(runPlants(caseDir)).rejects.toThrow(/escapes/);
    rmSync(caseDir, { recursive: true });
  });

  it('handles a multi-line PEM insert followed by an aws-key insert at a post-PEM line', async () => {
    // Regression coverage for the multi-line insert contract. A PEM plant
    // adds 6 lines to the file. A subsequent plant on the same file must
    // reference a line in the POST-PEM coordinate space; the runner re-reads
    // the file between plants so the second template sees the mutated state.
    // If line accounting broke, the aws-key would land inside the PEM block
    // (mangling the PEM markers) instead of after it.
    const caseDir = mkdtempSync(join(tmpdir(), 'plant-runner-multiline-'));
    mkdirSync(join(caseDir, 'before/src'), { recursive: true });
    writeFileSync(
      join(caseDir, 'before/src/secrets.ts'),
      ['export const config = {', '  region: "us-east-1",', '};', ''].join('\n'),
    );
    writeFileSync(
      join(caseDir, 'plants.yml'),
      [
        'plants:',
        // PEM block goes ABOVE line 3 — adds 6 lines (declaration + 4 PEM
        // markers + closing backtick line), so the original line 3 (`};`)
        // moves to line 9 and the original line 4 (blank) moves to line 10.
        '  - type: secret:pem-private-key',
        '    file: src/secrets.ts',
        '    line: 3',
        // AWS key at line 10 — should land BETWEEN the PEM closer and the
        // original blank line, NOT inside the PEM block. If offset
        // accounting broke, this would corrupt the PEM markers.
        '  - type: secret:aws-access-key',
        '    file: src/secrets.ts',
        '    line: 10',
      ].join('\n'),
    );
    await runPlants(caseDir);

    const mutated = readFileSync(join(caseDir, 'after/src/secrets.ts'), 'utf-8');
    const lines = mutated.split('\n');
    // PEM markers must remain intact (no AWS-key line spliced in between).
    const beginIdx = lines.findIndex((l) => l === '-----BEGIN PRIVATE KEY-----');
    const endIdx = lines.findIndex((l) => l === '-----END PRIVATE KEY-----');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(beginIdx);
    // No AWS key line falls between header and footer.
    for (let i = beginIdx; i <= endIdx; i++) {
      expect(lines[i]).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
    // The AWS key lands somewhere AFTER the PEM closer.
    const awsIdx = lines.findIndex((l) => l.includes('AKIAIOSFODNN7EXAMPLE'));
    expect(awsIdx).toBeGreaterThan(endIdx);

    const truth = parseYaml(readFileSync(join(caseDir, 'truth.yml'), 'utf-8')) as {
      truths: Array<Record<string, unknown>>;
    };
    expect(truth.truths).toHaveLength(2);
    expect(truth.truths[0]!.bug_type).toBe('secret:pem-private-key');
    expect(truth.truths[1]!.bug_type).toBe('secret:aws-access-key');
    // The PEM truth's line_range covers the 4 PEM marker lines.
    expect(truth.truths[0]!.line_range).toEqual([beginIdx + 1, endIdx + 1]);
    // The AWS truth anchors at the line the user requested (10, in the
    // post-PEM coordinate space) — that's also where the AWS key actually
    // ended up.
    expect(truth.truths[1]!.line_range).toEqual([awsIdx + 1, awsIdx + 1]);

    rmSync(caseDir, { recursive: true });
  });

  it('applies a replace-anchored plant by swapping the marker line', async () => {
    // Confirms the replace-anchor contract works inside the runner: the
    // template finds `// PLANT_ANCHOR: off-by-one-loop` in the before/ file
    // and swaps it for the buggy loop, then writes the result to after/.
    const caseDir = mkdtempSync(join(tmpdir(), 'plant-runner-anchor-'));
    mkdirSync(join(caseDir, 'before/src/util'), { recursive: true });
    writeFileSync(
      join(caseDir, 'before/src/util/sum.ts'),
      [
        'export function sumAll(arr: number[]): number {',
        '  let sum = 0;',
        '  // PLANT_ANCHOR: off-by-one-loop',
        '  return sum;',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(caseDir, 'plants.yml'),
      ['plants:', '  - type: off-by-one-loop', '    file: src/util/sum.ts'].join('\n'),
    );
    await runPlants(caseDir);

    const mutated = readFileSync(join(caseDir, 'after/src/util/sum.ts'), 'utf-8');
    expect(mutated).toContain('for (let i = 0; i <= arr.length; i++)');
    expect(mutated).not.toContain('PLANT_ANCHOR');

    const truth = parseYaml(readFileSync(join(caseDir, 'truth.yml'), 'utf-8')) as {
      truths: Array<Record<string, unknown>>;
    };
    expect(truth.truths).toHaveLength(1);
    expect(truth.truths[0]!.bug_type).toBe('off-by-one-loop');
    expect(truth.truths[0]!.line_range).toEqual([3, 3]);

    rmSync(caseDir, { recursive: true });
  });
});
