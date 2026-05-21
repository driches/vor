import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { pythonRequirementsParser } from './python-requirements.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'requirements.txt',
    status: 'modified',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    language: 'plaintext',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

describe('pythonRequirementsParser.matches', () => {
  it('matches requirements.txt and common variants', () => {
    expect(pythonRequirementsParser.matches(makeFile({ path: 'requirements.txt' }))).toBe(true);
    expect(pythonRequirementsParser.matches(makeFile({ path: 'requirements-dev.txt' }))).toBe(true);
    expect(pythonRequirementsParser.matches(makeFile({ path: 'requirements-prod.txt' }))).toBe(
      true,
    );
    expect(pythonRequirementsParser.matches(makeFile({ path: 'requirements_test.txt' }))).toBe(
      true,
    );
    expect(pythonRequirementsParser.matches(makeFile({ path: 'app/requirements.txt' }))).toBe(true);
  });

  it('does not match unrelated text files', () => {
    expect(pythonRequirementsParser.matches(makeFile({ path: 'pyproject.toml' }))).toBe(false);
    expect(pythonRequirementsParser.matches(makeFile({ path: 'requirements.in' }))).toBe(false);
    expect(pythonRequirementsParser.matches(makeFile({ path: 'notes.txt' }))).toBe(false);
  });
});

describe('pythonRequirementsParser.parse', () => {
  it('extracts == pins and records their 1-indexed line numbers', () => {
    const content = [
      '# Production requirements',
      'requests==2.28.1',
      '',
      'django==4.2.0',
      'urllib3>=1.26',
      '-r common.txt',
      '--index-url=https://pypi.org/simple',
      'flask==2.3.2 ; python_version > "3.7"',
      'cryptography==41.0.1 --hash=sha256:abc123',
    ].join('\n');

    const deps = pythonRequirementsParser.parse(content);

    expect(deps).toEqual([
      { ecosystem: 'PyPI', name: 'requests', version: '2.28.1', line: 2 },
      { ecosystem: 'PyPI', name: 'django', version: '4.2.0', line: 4 },
      { ecosystem: 'PyPI', name: 'flask', version: '2.3.2', line: 8 },
      { ecosystem: 'PyPI', name: 'cryptography', version: '41.0.1', line: 9 },
    ]);
  });

  it('skips comment-only lines, range pins, -r includes, and --flag lines', () => {
    const content = [
      '# comment',
      'urllib3>=1.26',
      'numpy~=1.24',
      'pandas!=1.5.0',
      'scipy<2.0',
      '-r dev.txt',
      '--requirement other.txt',
      '--find-links=./wheels',
      '-e .',
      '',
    ].join('\n');

    expect(pythonRequirementsParser.parse(content)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(pythonRequirementsParser.parse('')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const content = ['requests==2.28.1', 'django==4.2.0'].join('\r\n');
    const deps = pythonRequirementsParser.parse(content);
    expect(deps).toHaveLength(2);
    expect(deps[0]!.line).toBe(1);
    expect(deps[1]!.line).toBe(2);
  });

  it('tolerates an inline trailing comment after the version', () => {
    const content = 'requests==2.28.1  # pinned for CVE workaround\n';
    const deps = pythonRequirementsParser.parse(content);
    expect(deps).toEqual([{ ecosystem: 'PyPI', name: 'requests', version: '2.28.1', line: 1 }]);
  });
});
