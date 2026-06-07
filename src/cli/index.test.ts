import { describe, expect, it } from 'vitest';
import { buildProgram } from './index.js';

describe('vor CLI program', () => {
  it('registers the full command surface', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['config', 'dashboard', 'mcp', 'review', 'runs'].sort());
  });

  it('exposes a version', () => {
    expect(buildProgram().version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
