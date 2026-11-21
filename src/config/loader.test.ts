import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './defaults.js';
import { loadConfigFromString, loadConfigStrict } from './loader.js';
import { configSchema, partialConfigSchema } from './schema.js';
import { ConfigError } from '../util/errors.js';
import { logger } from '../util/logger.js';

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

describe('partial schema keeps what the full schema enforces', () => {
  it('rejects an unknown top-level key (the root object is strict)', () => {
    expect(() => loadConfigStrict('modle: claude-haiku-4-5\n')).toThrowError(/Unrecognized key/);
  });

  it('strips an unknown key under a non-strict section and keeps its siblings', () => {
    const cfg = loadConfigStrict(`
severity:
  floor: nit
  not_a_field: 1
`);
    expect(cfg.severity).toEqual({ ...DEFAULT_CONFIG.severity, floor: 'nit' });
  });

  it('accepts a single deeply nested override', () => {
    const cfg = loadConfigStrict(`
context:
  blast_radius:
    max_symbols: 5
`);
    expect(cfg.context.blast_radius).toEqual({
      ...DEFAULT_CONFIG.context.blast_radius,
      max_symbols: 5,
    });
    expect(cfg.context.include).toEqual(DEFAULT_CONFIG.context.include);
  });

  it('still applies bounds to a nested override', () => {
    expect(() =>
      loadConfigStrict(`
context:
  blast_radius:
    max_symbols: 500
`),
    ).toThrowError(ConfigError);
  });

  it('rejects an integer above the safe-integer range instead of rounding it', () => {
    expect(() =>
      loadConfigStrict(`
budget:
  max_input_tokens: 9007199254740993
`),
    ).toThrowError(ConfigError);
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
    expect(cfg.security.scanners.sast.semgrep?.custom_rules_path).toBe('.vor/semgrep-rules');
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
    expect(cfg.security.scanners.sast.semgrep?.custom_rules_path).toBe('rules/semgrep');
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

describe('provider-specific config', () => {
  it('merges OpenAI request controls with defaults', () => {
    const cfg = loadConfigFromString(`
providers:
  openai:
    service_tier: flex
    prompt_cache_key: driches/vor
    prompt_cache_retention: 24h
    reasoning_effort: low
    text_verbosity: low
`);
    expect(cfg.providers.openai).toEqual({
      service_tier: 'flex',
      prompt_cache_key: 'driches/vor',
      prompt_cache_retention: '24h',
      reasoning_effort: 'low',
      text_verbosity: 'low',
    });
  });

  it('rejects invalid OpenAI enum values', () => {
    const result = partialConfigSchema.safeParse({
      providers: { openai: { service_tier: 'premium' } },
    });
    expect(result.success).toBe(false);
  });

  it('accepts max as a catalogued OpenAI reasoning effort', () => {
    const cfg = loadConfigStrict(`
model: gpt-5.6-sol
providers:
  openai:
    reasoning_effort: max
`);
    expect(cfg.providers.openai.reasoning_effort).toBe('max');
  });

  it('rejects unknown values on the normal reasoning-effort field', () => {
    expect(() =>
      loadConfigStrict(`
providers:
  openai:
    reasoning_effort: ultra
`),
    ).toThrowError(ConfigError);
  });

  it('preserves an explicitly unsafe future reasoning-effort override', () => {
    const cfg = loadConfigStrict(`
model: gpt-future
providers:
  openai:
    unsafe_reasoning_effort_override: future-1
`);
    expect(cfg.providers.openai.unsafe_reasoning_effort_override).toBe('future-1');
  });

  it('rejects simultaneous normal and unsafe reasoning-effort fields', () => {
    expect(() =>
      loadConfigStrict(`
providers:
  openai:
    reasoning_effort: high
    unsafe_reasoning_effort_override: future-1
`),
    ).toThrowError(/cannot be combined with reasoning_effort/);
  });

  it('rejects empty, whitespace, and log-unsafe override values', () => {
    for (const value of ['""', '" future "', '"future/value"']) {
      expect(() =>
        loadConfigStrict(`
providers:
  openai:
    unsafe_reasoning_effort_override: ${value}
`),
      ).toThrowError(ConfigError);
    }
  });

  it('rejects reasoning mode names in the unsafe effort override', () => {
    for (const value of ['pro', 'standard']) {
      expect(() =>
        loadConfigStrict(`
providers:
  openai:
    unsafe_reasoning_effort_override: ${value}
`),
      ).toThrowError(/cannot use an OpenAI reasoning mode as a reasoning effort/);
    }
  });

  it('rejects misspelled OpenAI keys instead of stripping them', () => {
    expect(() =>
      loadConfigStrict(`
providers:
  openai:
    reasoning_effrot: max
`),
    ).toThrowError(/Unrecognized key/);
  });

  it('rejects a misspelled OpenAI provider key instead of stripping it', () => {
    expect(() =>
      loadConfigStrict(`
providers:
  opneai:
    reasoning_effort: max
`),
    ).toThrowError(/Unrecognized key/);
  });

  it('warns and falls back to defaults for a misspelled OpenAI key in safe loading', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockResolvedValue(undefined);
    try {
      const cfg = loadConfigFromString(`
model: gpt-5.6-sol
providers:
  openai:
    reasoning_effrot: max
`);
      expect(cfg).toEqual(DEFAULT_CONFIG);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unrecognized key'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('architecture config schema', () => {
  it('merges architecture defaults when omitted', () => {
    const cfg = loadConfigFromString('model: claude-sonnet-4-6');
    expect(cfg.architecture).toEqual(DEFAULT_CONFIG.architecture);
    expect(cfg.architecture.enabled).toBe(false);
  });

  it('accepts preset with partial layer overrides and custom rules', () => {
    const cfg = loadConfigFromString(`
architecture:
  enabled: true
  preset: hexagonal
  root: src
  severity: critical
  layers:
    domain:
      paths:
        - "src/core/domain/**"
      forbid_packages:
        - express
  contexts:
    pattern: "src/contexts/*"
    public_api:
      - "index.ts"
      - "contracts/**"
    allow_dependencies:
      checkout:
        - billing
  rules:
    - id: no-shared-to-adapters
      from: shared
      forbid_imports:
        - adapters_in
        - adapters_out
      reason: Shared kernel cannot import adapters.
  principles:
    - Domain entities must not take framework request objects.
`);
    expect(cfg.architecture.enabled).toBe(true);
    expect(cfg.architecture.preset).toBe('hexagonal');
    expect(cfg.architecture.root).toBe('src');
    expect(cfg.architecture.severity).toBe('critical');
    expect(cfg.architecture.llm_enforcement).toBe(true);
    expect(cfg.architecture.deterministic_enforcement).toBe(true);
    expect(cfg.architecture.ignore_tests).toBe(true);
    expect(cfg.architecture.layers?.domain?.paths).toEqual(['src/core/domain/**']);
    expect(cfg.architecture.contexts?.allow_dependencies?.checkout).toEqual(['billing']);
    expect(cfg.architecture.rules).toHaveLength(1);
    expect(cfg.architecture.principles).toHaveLength(1);
  });

  it('rejects unknown architecture preset', () => {
    const result = partialConfigSchema.safeParse({
      architecture: { enabled: true, preset: 'spaghetti' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside architecture block', () => {
    const result = partialConfigSchema.safeParse({
      architecture: { enabled: true, unknown_option: true },
    });
    expect(result.success).toBe(false);
  });
});

describe('references config schema', () => {
  it('merges references defaults when omitted', () => {
    const cfg = loadConfigFromString('model: claude-sonnet-4-6');
    expect(cfg.references).toEqual(DEFAULT_CONFIG.references);
    expect(cfg.references.enabled).toBe(false);
  });

  it('accepts shorthand strings, object sources, and cache/prompt_cache overrides', () => {
    const cfg = loadConfigFromString(`
references:
  enabled: true
  max_inline_bytes: 40000
  sources:
    - docs/standards.md
    - "docs/adr/**/*.md"
    - https://example.com/rfc.md
    - github:acme/standards/docs/ddd.md@main
    - id: api-guide
      title: API Style Guide
      url: https://example.com/api-guide.html
      mode: on_demand
      ttl_seconds: 3600
  cache:
    dir: .vor/ref-cache
    ttl_seconds: 7200
    stale_on_error: false
  prompt_cache:
    anthropic_ttl: 1h
    auto_openai_cache_key: false
`);
    expect(cfg.references.enabled).toBe(true);
    expect(cfg.references.max_inline_bytes).toBe(40_000);
    expect(cfg.references.sources).toHaveLength(5);
    expect(cfg.references.cache.dir).toBe('.vor/ref-cache');
    expect(cfg.references.cache.ttl_seconds).toBe(7200);
    expect(cfg.references.cache.stale_on_error).toBe(false);
    expect(cfg.references.prompt_cache.anthropic_ttl).toBe('1h');
    expect(cfg.references.prompt_cache.auto_openai_cache_key).toBe(false);
  });

  it('rejects invalid anthropic_ttl and unknown keys', () => {
    const badTtl = partialConfigSchema.safeParse({
      references: { prompt_cache: { anthropic_ttl: '2h' } },
    });
    expect(badTtl.success).toBe(false);

    const badKey = partialConfigSchema.safeParse({
      references: { unknown_field: true },
    });
    expect(badKey.success).toBe(false);
  });
});
