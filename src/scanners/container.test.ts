import { describe, expect, it } from 'vitest';
import { containerScannerStub } from './container.js';

describe('containerScannerStub', () => {
  it('is tagged with the container-cve scanner id', () => {
    expect(containerScannerStub.id).toBe('container-cve');
  });

  it('applies() returns false regardless of input', () => {
    expect(containerScannerStub.applies([])).toBe(false);
    expect(
      containerScannerStub.applies([
        {
          path: 'Dockerfile',
          status: 'modified',
          additions: 1,
          deletions: 0,
          reviewable_lines: [[1, 5]],
          language: 'dockerfile',
          is_generated: false,
          is_binary: false,
          size_bytes: 0,
          head_line_text: new Map(),
        },
      ]),
    ).toBe(false);
  });

  it('scan() resolves to an empty result with the correct scanner id', async () => {
    const result = await containerScannerStub.scan({} as never);
    expect(result.scanner).toBe('container-cve');
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.metrics.duration_ms).toBe(0);
    expect(result.metrics.files_examined).toBe(0);
    expect(result.metrics.network_calls).toBe(0);
    expect(result.metrics.cache_hits).toBe(0);
  });
});
