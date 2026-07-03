import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { goSumParser } from './go-sum.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'go.sum',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'plaintext',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('goSumParser.matches', () => {
  it('matches go.sum at the root and in subdirectories', () => {
    expect(goSumParser.matches(makeFile({ path: 'go.sum' }))).toBe(true);
    expect(goSumParser.matches(makeFile({ path: 'backend/go.sum' }))).toBe(true);
  });

  it('does not match go.mod or unrelated files', () => {
    expect(goSumParser.matches(makeFile({ path: 'go.mod' }))).toBe(false);
    expect(goSumParser.matches(makeFile({ path: 'go.sum.bak' }))).toBe(false);
    expect(goSumParser.matches(makeFile({ path: 'main.go' }))).toBe(false);
  });
});

describe('goSumParser.parse', () => {
  it('extracts module code lines, strips the v prefix, and skips /go.mod lines', () => {
    const content = [
      'github.com/gin-gonic/gin v1.6.3 h1:ahKqKTFpO5KTPHxWZjEdPScmYaGtLo8Y4DMHoEsnp14=',
      'github.com/gin-gonic/gin v1.6.3/go.mod h1:75u5sXoLsGZoRN5Sgbi1eraJ4GU3++wFwWzhwvtwp4M=',
      'golang.org/x/text v0.3.2 h1:tW2bmiBqwgJj/UpqtC8EpXEZVYOwU0yG4iWbprSVAcs=',
      'golang.org/x/text v0.3.2/go.mod h1:bEr9sfX3Q8Zfm5fL9x+3itogRgK3+ptLWKqgva+5dAk=',
    ].join('\n');

    expect(goSumParser.parse(content)).toEqual([
      { ecosystem: 'Go', name: 'github.com/gin-gonic/gin', version: '1.6.3', line: 1 },
      { ecosystem: 'Go', name: 'golang.org/x/text', version: '0.3.2', line: 3 },
    ]);
  });

  it('skips a module present ONLY via its /go.mod line (pruned indirect dep)', () => {
    // Go 1.17+ module-graph pruning: the module's code never ships, so its
    // CVEs are not this build's CVEs.
    const content =
      'github.com/pruned/mod v2.0.0/go.mod h1:aGO1c2VkTm90UmVhbEhhc2hCdXRWYWxpZFNoYXBlPQ=';
    expect(goSumParser.parse(content)).toEqual([]);
  });

  it('keeps pseudo-versions and +incompatible suffixes (v prefix stripped)', () => {
    const content = [
      'github.com/foo/bar v0.0.0-20190603091049-60506f45cf65 h1:qIbj1fsPNlZgppZ+VLlY7N33q108Sa+fhmuc+sWQYwY=',
      'github.com/docker/docker v20.10.24+incompatible h1:Ugvxm7a8+Gz6vqQYQQ2W7GYq5EUPaAiuPgIfVyI3dYE=',
    ].join('\n');

    expect(goSumParser.parse(content)).toEqual([
      {
        ecosystem: 'Go',
        name: 'github.com/foo/bar',
        version: '0.0.0-20190603091049-60506f45cf65',
        line: 1,
      },
      {
        ecosystem: 'Go',
        name: 'github.com/docker/docker',
        version: '20.10.24+incompatible',
        line: 2,
      },
    ]);
  });

  it('ignores malformed lines and blank lines rather than throwing', () => {
    const content = [
      '',
      'not a go.sum line',
      'github.com/missing/hash v1.0.0',
      'github.com/wrong/hash-prefix v1.0.0 sha256:abcdef',
      'github.com/ok/mod v1.2.3 h1:c2FtcGxlLWhhc2gtdmFsdWUtZm9yLXRlc3Rpbmc9PT0=',
    ].join('\n');

    expect(goSumParser.parse(content)).toEqual([
      { ecosystem: 'Go', name: 'github.com/ok/mod', version: '1.2.3', line: 5 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(goSumParser.parse('')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const content = [
      'github.com/a/b v1.0.0 h1:Zm9yY2VkLWZpeHR1cmUtaGFzaC1mb3ItdGVzdHM9PT0=',
      'github.com/c/d v2.0.0 h1:c2Vjb25kLWZpeHR1cmUtaGFzaC1mb3ItdGVzdHM9PT0=',
    ].join('\r\n');
    const deps = goSumParser.parse(content);
    expect(deps).toHaveLength(2);
    expect(deps[0]!.line).toBe(1);
    expect(deps[1]!.line).toBe(2);
  });
});
