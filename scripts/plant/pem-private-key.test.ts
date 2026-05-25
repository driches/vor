import { describe, expect, it } from 'vitest';
import { pemPrivateKeyTemplate } from './pem-private-key.js';
import type { PlantConfig } from '../eval/types.js';

describe('pemPrivateKeyTemplate', () => {
  it('inserts a 4-line PEM block at the requested line', () => {
    const source = ['line1', 'line2', 'line3'].join('\n');
    const { mutated, truth } = pemPrivateKeyTemplate.apply(source, {
      type: 'secret:pem-private-key',
      file: 'src/keys/signing.ts',
      line: 2,
    });
    const lines = mutated.split('\n');
    expect(lines).toContain('-----BEGIN PRIVATE KEY-----');
    expect(lines).toContain('-----END PRIVATE KEY-----');
    expect(truth.file).toBe('src/keys/signing.ts');
    expect(truth.bug_type).toBe('secret:pem-private-key');
    expect(truth.severity).toBe('critical');
    expect(truth.category).toEqual(['vulnerability', 'security']);
  });

  it('reports a 4-line truth range spanning header → footer', () => {
    // The inserted block at line `L` is:
    //   L:     const PLANTED_PRIVATE_KEY = `
    //   L+1:   -----BEGIN PRIVATE KEY-----
    //   L+2:   <body line 1>
    //   L+3:   <body line 2>
    //   L+4:   -----END PRIVATE KEY-----
    //   L+5:   `;
    // Truth covers lines L+1 .. L+4 so a finding anywhere inside the PEM
    // markers (regardless of which line it's anchored at) overlaps via
    // ±3 line slack in scoreRun.
    const source = ['line1', 'line2', 'line3'].join('\n');
    const { mutated, truth } = pemPrivateKeyTemplate.apply(source, {
      type: 'secret:pem-private-key',
      file: 'x.ts',
      line: 2,
    });
    expect(truth.line_range).toEqual([3, 6]);
    // Sanity-check the actual lines at the reported range.
    const lines = mutated.split('\n');
    expect(lines[2]).toBe('-----BEGIN PRIVATE KEY-----');
    expect(lines[5]).toBe('-----END PRIVATE KEY-----');
  });

  it('rejects a line outside the file', () => {
    expect(() =>
      pemPrivateKeyTemplate.apply('a\nb', {
        type: 'secret:pem-private-key',
        file: 'x.ts',
        line: 99,
      }),
    ).toThrow(/line/i);
  });

  it('throws when `file` is missing or empty', () => {
    expect(() =>
      pemPrivateKeyTemplate.apply('a\nb', {
        type: 'secret:pem-private-key',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
