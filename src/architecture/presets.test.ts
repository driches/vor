import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { generateStarterYaml, listPresets, resolveArchitectureSpec } from './presets.js';

describe('resolveArchitectureSpec', () => {
  it('defaults to hexagonal when enabled without explicit preset or custom structure', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
    });
    expect(spec.preset).toBe('hexagonal');
    expect(spec.layers.domain?.cannot_import).toContain('adapters_out');
    expect(spec.layers.domain?.forbid_packages).toContain('express');
    expect(spec.layers.adapters_in?.cannot_import).toContain('adapters_out');
    expect(spec.principles.length).toBeGreaterThan(0);
  });

  it('merges partial layer overrides onto preset without dropping dependency rules', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'hexagonal',
      layers: {
        domain: { paths: ['core/domain/**'] },
        reporting: { paths: ['core/reporting/**'], can_import: ['reporting', 'domain'] },
      },
    });
    expect(spec.layers.domain?.paths).toEqual(['core/domain/**']);
    expect(spec.layers.domain?.cannot_import).toContain('adapters_out');
    expect(spec.layers.domain?.forbid_packages).toContain('prisma');
    expect(spec.layers.reporting?.paths).toEqual(['core/reporting/**']);
  });

  it('scopes default preset globs and context patterns to root when specified', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'ddd',
      root: 'services/orders/src/',
    });
    expect(spec.root).toBe('services/orders/src');
    expect(spec.layers.domain?.paths).toContain('services/orders/src/domain/**');
    expect(spec.layers.domain?.paths).toContain('services/orders/src/**/domain/**');
    expect(spec.contexts?.pattern).toBe('services/orders/src/contexts/*');
  });

  it('respects include_preset_principles: false', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      preset: 'clean',
      include_preset_principles: false,
      principles: ['Only one custom principle.'],
    });
    expect(spec.principles).toEqual(['Only one custom principle.']);
  });

  it('uses custom preset when user defines layers without specifying preset', () => {
    const spec = resolveArchitectureSpec({
      ...DEFAULT_CONFIG.architecture,
      enabled: true,
      layers: {
        core: { paths: ['src/core/**'], can_import: ['core'] },
      },
    });
    expect(spec.preset).toBe('custom');
    expect(Object.keys(spec.layers)).toEqual(['core']);
  });
});

describe('listPresets & generateStarterYaml', () => {
  it('exposes all 6 presets and generates parseable starter YAML', () => {
    const presets = listPresets();
    expect(presets.map((p) => p.id)).toEqual([
      'hexagonal',
      'ddd',
      'clean',
      'layered',
      'modular-monolith',
      'custom',
    ]);
    for (const p of presets) {
      const yaml = generateStarterYaml(p.id, { root: 'src' });
      expect(yaml).toContain(`preset: ${p.id}`);
    }
  });
});
