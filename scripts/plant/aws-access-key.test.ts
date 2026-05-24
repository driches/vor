import { describe, expect, it } from 'vitest';
import { awsAccessKeyTemplate } from './aws-access-key.js';
import type { PlantConfig } from '../eval/types.js';

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

  it('throws when `file` param is missing or empty (regression: silent FN)', () => {
    // Regression for PR #10 dogfood MINOR 3295156535. The previous template
    // defaulted truth.file to '' when config.file was missing or non-string,
    // and scoreRun then never matched (file_path === '' for no real finding),
    // guaranteeing FN for that plant with no diagnostic. Fail loud instead.
    // Cast to bypass the type-level requirement on `file`; the whole point
    // is to test that the runtime guard catches malformed plants.yml input.
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb\nc', {
        type: 'secret:aws-access-key',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
    expect(() =>
      awsAccessKeyTemplate.apply('a\nb\nc', {
        type: 'secret:aws-access-key',
        file: '',
        line: 1,
      } as unknown as PlantConfig),
    ).toThrow(/missing or empty 'file'/);
  });
});
