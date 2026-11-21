import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { ConfigError } from '../util/errors.js';
import {
  isSafeRelativePath,
  loadArchBaseline,
  mergeArchitectureConfig,
  parseExternalArchitectureYamlStrict,
  resolveEffectiveArchitectureConfig,
  resolveWorkspaceArchitectureConfig,
  saveArchBaseline,
} from './loader.js';

describe('isSafeRelativePath', () => {
  it('allows normal relative paths and rejects escapes or absolute paths', () => {
    expect(isSafeRelativePath('/ws', '.vor/architecture.yml')).toBe(true);
    expect(isSafeRelativePath('/ws', '../outside.yml')).toBe(false);
    expect(isSafeRelativePath('/ws', '/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('/ws', '')).toBe(false);
  });
});

describe('parseExternalArchitectureYamlStrict', () => {
  it('parses valid external architecture YAML', () => {
    const parsed = parseExternalArchitectureYamlStrict(`
preset: ddd
root: src
severity: critical
llm_enforcement: false
layers:
  domain:
    paths: ["src/core/**"]
rules:
  - id: no-http
    from: domain
    forbid_packages: [express]
    reason: Domain must stay transport-agnostic.
`);
    expect(parsed.preset).toBe('ddd');
    expect(parsed.severity).toBe('critical');
    expect(parsed.llm_enforcement).toBe(false);
    expect(parsed.rules).toHaveLength(1);
  });

  it('rejects rule missing both forbid_imports and forbid_packages', () => {
    expect(() =>
      parseExternalArchitectureYamlStrict(`
preset: custom
rules:
  - id: empty-rule
    from: domain
    reason: Missing targets.
`),
    ).toThrowError(ConfigError);
  });
});

describe('mergeArchitectureConfig & resolveEffectiveArchitectureConfig', () => {
  it('does zero I/O and returns inline config when disabled or file unset', async () => {
    const disabled = await resolveEffectiveArchitectureConfig(DEFAULT_CONFIG.architecture);
    expect(disabled).toEqual(DEFAULT_CONFIG.architecture);
  });

  it('loads external file from workspaceDir and preserves external scalar overrides over defaults', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-loader-'));
    try {
      mkdirSync(join(ws, '.vor'), { recursive: true });
      writeFileSync(
        join(ws, '.vor/architecture.yml'),
        `preset: ddd\nseverity: critical\nllm_enforcement: false\n`,
      );
      const effective = await resolveEffectiveArchitectureConfig(
        {
          ...DEFAULT_CONFIG.architecture,
          enabled: true,
          file: '.vor/architecture.yml',
        },
        { workspaceDir: ws },
      );
      expect(effective.preset).toBe('ddd');
      expect(effective.severity).toBe('critical');
      expect(effective.llm_enforcement).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('respects external enabled: false even when inline enabled is true', () => {
    const merged = mergeArchitectureConfig(
      { ...DEFAULT_CONFIG.architecture, enabled: true, file: '.vor/architecture.yml' },
      { enabled: false, preset: 'hexagonal' },
    );
    expect(merged.enabled).toBe(false);
  });

  it('merges partial layer fields between external file and inline overrides', () => {
    const merged = mergeArchitectureConfig(
      {
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        file: '.vor/architecture.yml',
        layers: {
          domain: { severity: 'critical' },
        },
      },
      {
        preset: 'custom',
        layers: {
          domain: { paths: ['src/core/**'], forbid_packages: ['express'] },
          infra: { paths: ['src/infra/**'] },
        },
      },
    );
    expect(merged.layers?.domain).toEqual({
      paths: ['src/core/**'],
      forbid_packages: ['express'],
      severity: 'critical',
    });
    expect(merged.layers?.infra).toEqual({ paths: ['src/infra/**'] });
  });
});

describe('baseline persistence', () => {
  it('saves sorted unique fingerprints and reloads them cleanly', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-base-'));
    try {
      saveArchBaseline(ws, '.vor/arch-baseline.json', ['bbb', 'aaa', 'bbb']);
      const loaded = loadArchBaseline(ws, '.vor/arch-baseline.json');
      expect([...loaded]).toEqual(['aaa', 'bbb']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('degrades gracefully when baseline file is missing or corrupt', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-base-bad-'));
    try {
      expect(loadArchBaseline(ws, '.vor/missing.json').size).toBe(0);
      writeFileSync(join(ws, 'bad.json'), '{not-json');
      expect(loadArchBaseline(ws, 'bad.json').size).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('resolveWorkspaceArchitectureConfig', () => {
  it('auto-discovers .vor/architecture.yml when .vor.yml has no architecture block', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-ws-arch-'));
    try {
      mkdirSync(join(ws, '.vor'), { recursive: true });
      writeFileSync(join(ws, '.vor/architecture.yml'), 'preset: clean\nroot: src\n');
      const resolved = resolveWorkspaceArchitectureConfig({ workspaceDir: ws, strict: true });
      expect(resolved.architecture.enabled).toBe(true);
      expect(resolved.architecture.preset).toBe('clean');
      expect(resolved.architecture.root).toBe('src');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('preserves explicit inline scalars equal to defaults over external config while inheriting omitted scalars', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-ws-explicit-inline-'));
    try {
      mkdirSync(join(ws, '.vor'), { recursive: true });
      writeFileSync(
        join(ws, '.vor.yml'),
        [
          'architecture:',
          '  enabled: true',
          '  file: .vor/architecture.yml',
          '  severity: important',
          '  llm_enforcement: true',
        ].join('\n'),
      );
      writeFileSync(
        join(ws, '.vor/architecture.yml'),
        ['preset: ddd', 'severity: critical', 'llm_enforcement: false', 'ignore_tests: false'].join(
          '\n',
        ),
      );

      const resolved = resolveWorkspaceArchitectureConfig({ workspaceDir: ws, strict: true });
      expect(resolved.architecture.severity).toBe('important');
      expect(resolved.architecture.llm_enforcement).toBe(true);
      expect(resolved.architecture.ignore_tests).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('rejects escaping configPath or archConfigPath', () => {
    expect(() =>
      resolveWorkspaceArchitectureConfig({
        workspaceDir: '/tmp/ws',
        archConfigPath: '../outside.yml',
      }),
    ).toThrowError(ConfigError);
  });
});
