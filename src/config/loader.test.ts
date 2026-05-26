import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaults.js';
import { loadConfigFromString, loadConfigStrict } from './loader.js';
import { configSchema, partialConfigSchema } from './schema.js';
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

describe('security config schema', () => {
  it('DEFAULT_CONFIG parses cleanly through the strict schema', () => {
    expect(() => configSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });

  it('valid config without security: block merges security defaults', () => {
    // Non-empty YAML so we exercise parse → safeParse(partial) → deepMerge,
    // not the empty-string early-return in loadConfigFromString.
    const cfg = loadConfigFromString('model: claude-opus-4-7');
    expect(cfg.security).toEqual(DEFAULT_CONFIG.security);
  });

  it('partial security override merges into defaults', () => {
    const cfg = loadConfigFromString(`
security:
  enabled: false
`);
    expect(cfg.security.enabled).toBe(false);
    // Sibling fields preserved from defaults
    expect(cfg.security.ignore_file).toBe(DEFAULT_CONFIG.security.ignore_file);
    expect(cfg.security.scanners.dependency_cve.enabled).toBe(true);
    expect(cfg.security.scanners.secrets.include_generic_entropy).toBe(false);
  });

  it('rejects non-URL osv_endpoint', () => {
    const result = partialConfigSchema.safeParse({
      security: {
        scanners: {
          dependency_cve: { enabled: true, osv_endpoint: 'not-a-url' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid URL osv_endpoint', () => {
    const result = partialConfigSchema.safeParse({
      security: {
        scanners: {
          dependency_cve: { enabled: true, osv_endpoint: 'https://api.osv.dev/v1/query' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  // v0.4.1 backwards-compat regression test: a config written before
  // custom_rules_path existed must still validate AND must NOT lose its
  // sibling sast fields when merged with defaults.
  it('accepts an old-style sast config with no semgrep block', () => {
    const cfg = loadConfigFromString(`
security:
  scanners:
    sast:
      enabled: true
`);
    expect(cfg.security.scanners.sast.enabled).toBe(true);
    // Default semgrep block is preserved (custom_rules_path falls back to
    // the bundled rule pack location).
    expect(cfg.security.scanners.sast.semgrep?.custom_rules_path).toBe(
      '.code-review/semgrep-rules',
    );
  });

  it('accepts an explicit custom_rules_path override', () => {
    const cfg = loadConfigFromString(`
security:
  scanners:
    sast:
      enabled: true
      semgrep:
        custom_rules_path: rules/semgrep
`);
    expect(cfg.security.scanners.sast.semgrep?.custom_rules_path).toBe(
      'rules/semgrep',
    );
  });

  it('accepts the empty-string opt-out for custom_rules_path', () => {
    // Empty string is the explicit "use only --config=auto" sentinel —
    // distinguishable from "field unset, fall back to bundled rules".
    const cfg = loadConfigFromString(`
security:
  scanners:
    sast:
      semgrep:
        custom_rules_path: ""
`);
    expect(cfg.security.scanners.sast.semgrep?.custom_rules_path).toBe('');
  });
});

describe('provider field', () => {
  it('accepts provider: anthropic', () => {
    const result = partialConfigSchema.safeParse({ provider: 'anthropic' });
    expect(result.success).toBe(true);
  });

  it('accepts provider: openai', () => {
    const cfg = loadConfigFromString('provider: openai\nmodel: gpt-4.1');
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4.1');
  });

  it('rejects an unknown provider value (and falls back to defaults via loader)', () => {
    // Schema-level: explicit assertion that an unknown enum value is rejected.
    const schemaResult = partialConfigSchema.safeParse({ provider: 'gemini' });
    expect(schemaResult.success).toBe(false);

    // Loader-level: the safe loader degrades to defaults on validation failure
    // (defaults have provider unset, since omission means infer-from-model).
    const cfg = loadConfigFromString('provider: gemini');
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
  });
});
