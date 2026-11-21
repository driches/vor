import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { resolveArchitectureSpec } from './presets.js';
import { renderArchitecturePrompt } from './prompt.js';

describe('renderArchitecturePrompt', () => {
  it('returns null when disabled or llm_enforcement is false', () => {
    expect(
      renderArchitecturePrompt(resolveArchitectureSpec(DEFAULT_CONFIG.architecture)),
    ).toBeNull();
    expect(
      renderArchitecturePrompt(
        resolveArchitectureSpec({
          ...DEFAULT_CONFIG.architecture,
          enabled: true,
          llm_enforcement: false,
        }),
      ),
    ).toBeNull();
  });

  it('renders layers, parallel-scanner guidance, and principles when enabled', () => {
    const rendered = renderArchitecturePrompt(
      resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'ddd',
        root: 'src',
        principles: ['Order aggregates must emit OrderPlaced events.'],
      }),
    );
    expect(rendered).toContain('### Software architecture standards');
    expect(rendered).toContain('**ddd**');
    expect(rendered).toContain('scoped under `src`');
    expect(rendered).toContain('deterministic architecture scanner runs in parallel');
    expect(rendered).toContain('Bounded contexts / modules');
    expect(rendered).toContain('Order aggregates must emit OrderPlaced events.');
    expect(rendered).toContain('category: "architecture"');
  });

  it('omits parallel-scanner note when deterministic_enforcement is false', () => {
    const rendered = renderArchitecturePrompt(
      resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
        deterministic_enforcement: false,
      }),
    );
    expect(rendered).not.toContain('deterministic architecture scanner runs in parallel');
  });
});
