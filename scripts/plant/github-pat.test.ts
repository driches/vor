import { describe, expect, it } from 'vitest';
import { githubPatTemplate } from './github-pat.js';
import type { PlantConfig } from '../eval/types.js';

describe('githubPatTemplate', () => {
  it('inserts a ghp_ literal at the requested line and produces a matching truth', () => {
    const source = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const { mutated, truth } = githubPatTemplate.apply(source, {
      type: 'secret:github-pat',
      file: 'src/ci/tokens.ts',
      line: 3,
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(lines[2]).toMatch(/^const\s/);
    expect(truth).toEqual({
      file: 'src/ci/tokens.ts',
      line_range: [3, 3],
      bug_type: 'secret:github-pat',
      severity: 'critical',
      category: ['vulnerability', 'security'],
    });
  });

  it('accepts a custom value as long as it matches ghp_ + 36 chars', () => {
    const value = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    expect(value).toMatch(/^ghp_[A-Za-z0-9]{36}$/); // sanity
    const { mutated } = githubPatTemplate.apply('a\nb', {
      type: 'secret:github-pat',
      file: 'x.ts',
      line: 1,
      value,
    });
    expect(mutated).toContain(value);
  });

  it('rejects a value that does not match the classic-PAT regex', () => {
    expect(() =>
      githubPatTemplate.apply('a\nb', {
        type: 'secret:github-pat',
        file: 'x.ts',
        line: 1,
        value: 'not-a-pat',
      }),
    ).toThrow(/classic-PAT/);
  });

  it('rejects a line number outside the file', () => {
    expect(() =>
      githubPatTemplate.apply('a\nb', {
        type: 'secret:github-pat',
        file: 'x.ts',
        line: 99,
      }),
    ).toThrow(/line/i);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      githubPatTemplate.apply('a\nb', {
        type: 'secret:github-pat',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
