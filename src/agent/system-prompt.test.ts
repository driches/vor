import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { buildSystemPrompt } from './system-prompt.js';

describe('buildSystemPrompt', () => {
  it('includes the base discipline text', () => {
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'owner/repo',
      contextFiles: [],
    });
    expect(p).toContain('senior staff engineer');
    expect(p).toContain('post_inline_comment');
    expect(p).toContain('post_summary');
    expect(p).toContain('Severity calibration');
  });

  it('includes focus areas based on config', () => {
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'r',
      contextFiles: [],
    });
    expect(p).toContain('Prioritize:');
    expect(p).toContain('security');
    expect(p).toContain('tests');
  });

  it('appends repo-specific prompt additions', () => {
    const p = buildSystemPrompt({
      config: { ...DEFAULT_CONFIG, prompt: { additions: 'We do not use class components.' } },
      repoName: 'r',
      contextFiles: [],
    });
    expect(p).toContain('Repo-specific instructions');
    expect(p).toContain('class components');
  });

  it('includes context files when provided', () => {
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'driches/orbitboard',
      contextFiles: [
        { file: 'CLAUDE.md', content: '## We use React Server Components.' },
        { file: 'AGENTS.md', content: '## We test with vitest.' },
      ],
    });
    expect(p).toContain('Repo context (driches/orbitboard)');
    expect(p).toContain('React Server Components');
    expect(p).toContain('We test with vitest');
  });

  it('truncates context if it exceeds max_context_bytes', () => {
    const huge = 'x'.repeat(40_000);
    const p = buildSystemPrompt({
      config: { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, max_context_bytes: 5_000 } },
      repoName: 'r',
      contextFiles: [
        { file: 'CLAUDE.md', content: huge },
        { file: 'AGENTS.md', content: huge },
      ],
    });
    expect(p.length).toBeLessThan(15_000);
    expect(p).toMatch(/omitted due to size cap/);
  });
});
