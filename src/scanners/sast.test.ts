import { describe, expect, it } from 'vitest';
import { sastScannerStub } from './sast.js';

describe('sastScannerStub', () => {
  it('is tagged with the sast scanner id', () => {
    expect(sastScannerStub.id).toBe('sast');
  });

  it('applies() returns false regardless of input', () => {
    expect(sastScannerStub.applies([])).toBe(false);
    expect(
      sastScannerStub.applies([
        {
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
        },
      ]),
    ).toBe(false);
  });

  it('scan() resolves to an empty result with the correct scanner id', async () => {
    const result = await sastScannerStub.scan({} as never);
    expect(result.scanner).toBe('sast');
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.metrics.duration_ms).toBe(0);
    expect(result.metrics.files_examined).toBe(0);
    expect(result.metrics.network_calls).toBe(0);
    expect(result.metrics.cache_hits).toBe(0);
  });
});
