import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types.js';
import { cargoLockParser } from './cargo-lock.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'Cargo.lock',
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

describe('cargoLockParser.matches', () => {
  it('matches Cargo.lock at the root and in subdirectories', () => {
    expect(cargoLockParser.matches(makeFile({ path: 'Cargo.lock' }))).toBe(true);
    expect(cargoLockParser.matches(makeFile({ path: 'crates/foo/Cargo.lock' }))).toBe(true);
  });

  it('does not match Cargo.toml or unrelated files', () => {
    expect(cargoLockParser.matches(makeFile({ path: 'Cargo.toml' }))).toBe(false);
    expect(cargoLockParser.matches(makeFile({ path: 'src/main.rs' }))).toBe(false);
  });
});

describe('cargoLockParser.parse', () => {
  it('extracts crates.io packages and anchors on the version line', () => {
    const content = [
      'version = 3',
      '',
      '[[package]]',
      'name = "regex"',
      'version = "1.10.2"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "380b9a329e39ff7b91b96eb0f5c9b5a3d3e9f6e9e8b7c6d5e4f3a2b1c0d9e8f7"',
      '',
      '[[package]]',
      'name = "serde"',
      'version = "1.0.193"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "aabbccddeeff00112233445566778899aabbccddeeff001122334455667788"',
    ].join('\n');

    expect(cargoLockParser.parse(content)).toEqual([
      { ecosystem: 'crates.io', name: 'regex', version: '1.10.2', line: 5 },
      { ecosystem: 'crates.io', name: 'serde', version: '1.0.193', line: 11 },
    ]);
  });

  it('skips local path/workspace members (no source) and git dependencies', () => {
    const content = [
      '[[package]]',
      'name = "my-workspace-crate"',
      'version = "0.1.0"',
      'dependencies = [',
      ' "regex",',
      ']',
      '',
      '[[package]]',
      'name = "patched-dep"',
      'version = "2.0.0"',
      'source = "git+https://github.com/example/patched-dep?branch=main#abc123"',
      '',
      '[[package]]',
      'name = "regex"',
      'version = "1.10.2"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "deadbeef"',
    ].join('\n');

    expect(cargoLockParser.parse(content)).toEqual([
      { ecosystem: 'crates.io', name: 'regex', version: '1.10.2', line: 15 },
    ]);
  });

  it('does not treat trailing [metadata]/[[patch.unused]] tables as packages', () => {
    const content = [
      '[[package]]',
      'name = "openssl"',
      'version = "0.10.60"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      'checksum = "cafebabe"',
      '',
      '[[patch.unused]]',
      'name = "openssl"',
      'version = "0.10.99"',
      '',
      '[metadata]',
      'name = "should-not-appear"',
      'version = "9.9.9"',
    ].join('\n');

    expect(cargoLockParser.parse(content)).toEqual([
      { ecosystem: 'crates.io', name: 'openssl', version: '0.10.60', line: 3 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(cargoLockParser.parse('')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const content = [
      '[[package]]',
      'name = "a"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\r\n');
    const deps = cargoLockParser.parse(content);
    expect(deps).toEqual([{ ecosystem: 'crates.io', name: 'a', version: '1.0.0', line: 3 }]);
  });
});
