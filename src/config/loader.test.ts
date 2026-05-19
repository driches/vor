import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaults.js';
import { loadConfigFromString, loadConfigStrict } from './loader.js';
import { ConfigError } from '../util/errors.js';

describe('loadConfigFromString', () => {
  it('returns defaults for empty/null input', () => {
    expect(loadConfigFromString(null)).toEqual(DEFAULT_CONFIG);
    expect(loadConfigFromString(undefined)).toEqual(DEFAULT_CONFIG);
    expect(loadConfigFromString('')).toEqual(DEFAULT_CONFIG);
    expect(loadConfigFromString('   ')).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults for unparseable YAML (does not throw)', () => {
    const cfg = loadConfigFromString(': bad : yaml :');
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('returns defaults when YAML parses to non-object', () => {
    expect(loadConfigFromString('"just a string"')).toEqual(DEFAULT_CONFIG);
    expect(loadConfigFromString('42')).toEqual(DEFAULT_CONFIG);
  });

  it('merges single override field with defaults', () => {
    const cfg = loadConfigFromString('model: claude-opus-4-7');
    expect(cfg.model).toBe('claude-opus-4-7');
    expect(cfg.max_turns).toBe(DEFAULT_CONFIG.max_turns);
    expect(cfg.review.event).toBe('COMMENT');
  });

  it('merges nested fields without losing siblings', () => {
    const cfg = loadConfigFromString(`
severity:
  floor: critical
`);
    expect(cfg.severity.floor).toBe('critical');
    expect(cfg.severity.max_comments_per_file).toBe(DEFAULT_CONFIG.severity.max_comments_per_file);
    expect(cfg.severity.max_comments_total).toBe(DEFAULT_CONFIG.severity.max_comments_total);
  });

  it('replaces arrays rather than concatenating', () => {
    const cfg = loadConfigFromString(`
exclude:
  paths:
    - "custom/**"
`);
    expect(cfg.exclude.paths).toEqual(['custom/**']);
  });

  it('falls back to defaults when validation fails (does not throw)', () => {
    const cfg = loadConfigFromString(`
severity:
  floor: not-a-real-severity
`);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('honors review event override', () => {
    const cfg = loadConfigFromString(`
review:
  event: REQUEST_CHANGES
`);
    expect(cfg.review.event).toBe('REQUEST_CHANGES');
  });

  it('appends prompt additions', () => {
    const cfg = loadConfigFromString(`
prompt:
  additions: |
    Use react server components.
`);
    expect(cfg.prompt.additions).toContain('react server components');
  });
});

describe('loadConfigStrict', () => {
  it('throws on invalid YAML', () => {
    expect(() => loadConfigStrict(': bad : yaml :')).toThrowError(ConfigError);
  });

  it('throws on schema violation', () => {
    expect(() => loadConfigStrict('severity:\n  floor: bogus')).toThrowError(ConfigError);
  });

  it('returns merged config on valid input', () => {
    const cfg = loadConfigStrict('model: claude-opus-4-7');
    expect(cfg.model).toBe('claude-opus-4-7');
  });
});
