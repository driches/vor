import { describe, expect, it } from 'vitest';
import { awsAccessKeyTemplate } from './aws-access-key.js';

describe('awsAccessKeyTemplate', () => {
  it('inserts an AWS key literal at the requested line and produces a matching truth', () => {
    const source = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const { mutated, truth } = awsAccessKeyTemplate.apply(source, {
      type: 'secret:aws-access-key',
      file: 'src/config/aws.ts',
      line: 3,
      value: 'AKIAIOSFODNN7EXAMPLE',
    });
    const lines = mutated.split('\n');
    expect(lines[2]).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(lines[2]).toMatch(/^const\s/);
    expect(truth).toEqual({
      file: 'src/config/aws.ts',
      line_range: [3, 3],
      bug_type: 'secret:aws-access-key',
      severity: 'critical',
      category: ['vulnerability', 'security'],
    });
  });

  it('rejects a value that does not look like an AWS access key', () => {
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb\nc', {
        type: 'secret:aws-access-key',
        file: 'x.ts',
        line: 1,
        value: 'not-an-aws-key',
      }),
    ).toThrow(/AKIA/);
  });

  it('rejects a line number outside the file', () => {
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb', {
        type: 'secret:aws-access-key',
        file: 'x.ts',
        line: 99,
        value: 'AKIAIOSFODNN7EXAMPLE',
      }),
    ).toThrow(/line/i);
  });

  it('defaults to AKIAIOSFODNN7EXAMPLE when value is omitted', () => {
    const { mutated } = awsAccessKeyTemplate.apply('a\nb\nc', {
      type: 'secret:aws-access-key',
      file: 'x.ts',
      line: 2,
    });
    expect(mutated).toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
