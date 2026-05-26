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

  it('emits the static-analysis section when sast is enabled (default config)', () => {
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'r',
      contextFiles: [],
    });
    // The default config has sast.enabled = true; Sonnet should see the
    // "what static tools cover" framing so it doesn't redo lint-level work.
    expect(p).toContain('Static analysis runs in parallel');
    expect(p).toContain('ESLint');
    expect(p).toContain('Semgrep');
    // The section must include both directives: what static covers AND
    // what's still Sonnet's job. Iter 7 ("just be faster") regressed
    // recall — the explicit "DO spend your turns on" half is the
    // anti-regression safety belt.
    expect(p).toContain('DO NOT spend turns on');
    expect(p).toContain('DO spend your turns on');
    expect(p).toContain('Semantic correctness');
    // Static tools may be missing from a workspace; Sonnet must still
    // flag obvious lint-style bugs as a safety net.
    expect(p).toMatch(/safety net|safety-net/i);
  });

  it('omits the static-analysis section when sast is disabled', () => {
    const p = buildSystemPrompt({
      config: {
        ...DEFAULT_CONFIG,
        security: {
          ...DEFAULT_CONFIG.security,
          scanners: {
            ...DEFAULT_CONFIG.security.scanners,
            sast: { enabled: false },
          },
        },
      },
      repoName: 'r',
      contextFiles: [],
    });
    expect(p).not.toContain('Static analysis runs in parallel');
  });
});
