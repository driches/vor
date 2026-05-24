import { describe, expect, it } from 'vitest';
import { resolveCaseDir } from './case-paths.js';
import { resolve, sep } from 'node:path';

describe('resolveCaseDir', () => {
  it('resolves a normal case id to <goldenRepo>/cases/<id>', () => {
    const got = resolveCaseDir('/tmp/golden', 'demo');
    expect(got).toBe(resolve('/tmp/golden/cases/demo'));
  });

  it('rejects path traversal via "../"', () => {
    expect(() => resolveCaseDir('/tmp/golden', '../escape')).toThrow(
      /resolves outside cases root/,
    );
  });

  it('rejects deep path traversal via "../../"', () => {
    // `--case ../../tmp/x` would resolve to /tmp/x (outside /tmp/golden/cases).
    expect(() => resolveCaseDir('/tmp/golden', '../../tmp/x')).toThrow(
      /resolves outside cases root/,
    );
  });

  it('rejects an empty case id (resolves to cases root itself)', () => {
    // `resolve('/tmp/golden/cases', '')` === '/tmp/golden/cases', which would
    // make `runPlants` operate on the parent of every real case. Reject.
    expect(() => resolveCaseDir('/tmp/golden', '')).toThrow(
      /must name a specific case directory/,
    );
  });

  it('rejects a case id that points exactly at the cases root via "."', () => {
    expect(() => resolveCaseDir('/tmp/golden', '.')).toThrow(
      /must name a specific case directory/,
    );
  });

  it('allows nested case ids (e.g. "group/case-1")', () => {
    // Subdirectories under cases/ are legitimate organisational choices and
    // must NOT be confused with traversal escapes.
    const got = resolveCaseDir('/tmp/golden', 'group/case-1');
    expect(got).toBe(resolve(`/tmp/golden/cases${sep}group${sep}case-1`));
  });
});
