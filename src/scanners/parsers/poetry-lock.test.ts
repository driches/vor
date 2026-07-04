import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { poetryLockParser } from './poetry-lock.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'poetry.lock',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'plaintext',
    is_generated: true,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('poetryLockParser.matches', () => {
  it('matches poetry.lock at the root and in subdirectories', () => {
    expect(poetryLockParser.matches(makeFile({ path: 'poetry.lock' }))).toBe(true);
    expect(poetryLockParser.matches(makeFile({ path: 'services/api/poetry.lock' }))).toBe(true);
  });

  it('does not match pyproject.toml or unrelated files', () => {
    expect(poetryLockParser.matches(makeFile({ path: 'pyproject.toml' }))).toBe(false);
    expect(poetryLockParser.matches(makeFile({ path: 'requirements.txt' }))).toBe(false);
  });
});

describe('poetryLockParser.parse', () => {
  it('extracts PyPI packages and anchors on the version line', () => {
    const content = [
      '[[package]]',
      'name = "requests"',
      'version = "2.31.0"',
      'description = "Python HTTP for Humans."',
      'optional = false',
      'python-versions = ">=3.7"',
      '',
      '[package.dependencies]',
      'certifi = ">=2017.4.17"',
      'urllib3 = ">=1.21.1,<3"',
      '',
      '[[package]]',
      'name = "urllib3"',
      'version = "2.1.0"',
      'description = "HTTP library"',
      'optional = false',
      'python-versions = ">=3.8"',
    ].join('\n');

    expect(poetryLockParser.parse(content)).toEqual([
      { ecosystem: 'PyPI', name: 'requests', version: '2.31.0', line: 3 },
      { ecosystem: 'PyPI', name: 'urllib3', version: '2.1.0', line: 14 },
    ]);
  });

  it('does not read name/version from a [package.dependencies] sub-table', () => {
    // A dependency literally named `version` inside [package.dependencies] must
    // not overwrite the package's own version (which is why we only read the
    // top-level key section).
    const content = [
      '[[package]]',
      'name = "somepkg"',
      'version = "1.2.3"',
      '',
      '[package.dependencies]',
      'name = ">=1.0"',
      'version = ">=2.0"',
    ].join('\n');

    expect(poetryLockParser.parse(content)).toEqual([
      { ecosystem: 'PyPI', name: 'somepkg', version: '1.2.3', line: 3 },
    ]);
  });

  it('skips packages with a [package.source] table (git/path/url/legacy index)', () => {
    const content = [
      '[[package]]',
      'name = "mylib"',
      'version = "0.1.0"',
      'description = "vendored from git"',
      'optional = false',
      'python-versions = "*"',
      '',
      '[package.source]',
      'type = "git"',
      'url = "https://github.com/example/mylib.git"',
      'reference = "main"',
      'resolved_reference = "abc123"',
      '',
      '[[package]]',
      'name = "flask"',
      'version = "3.0.0"',
      'description = "web framework"',
      'optional = false',
      'python-versions = ">=3.8"',
    ].join('\n');

    expect(poetryLockParser.parse(content)).toEqual([
      { ecosystem: 'PyPI', name: 'flask', version: '3.0.0', line: 16 },
    ]);
  });

  it('does not treat the trailing [metadata] table as a package', () => {
    const content = [
      '[[package]]',
      'name = "jinja2"',
      'version = "3.1.2"',
      'description = "templating"',
      'optional = false',
      'python-versions = ">=3.7"',
      '',
      '[metadata]',
      'lock-version = "2.0"',
      'python-versions = "^3.11"',
      'content-hash = "deadbeef"',
    ].join('\n');

    expect(poetryLockParser.parse(content)).toEqual([
      { ecosystem: 'PyPI', name: 'jinja2', version: '3.1.2', line: 3 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(poetryLockParser.parse('')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const content = [
      '[[package]]',
      'name = "click"',
      'version = "8.1.7"',
      'optional = false',
      'python-versions = ">=3.7"',
    ].join('\r\n');
    expect(poetryLockParser.parse(content)).toEqual([
      { ecosystem: 'PyPI', name: 'click', version: '8.1.7', line: 3 },
    ]);
  });
});
