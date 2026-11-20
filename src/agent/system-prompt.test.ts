import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { sha256Hex } from '../references/cache.js';
import { buildSystemPrompt, selectEmbeddedContextFiles } from './system-prompt.js';

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
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, max_context_bytes: 5_000 },
      },
      repoName: 'r',
      contextFiles: [
        { file: 'CLAUDE.md', content: huge },
        { file: 'AGENTS.md', content: huge },
      ],
    });
    expect(p.length).toBeLessThan(15_000);
    expect(p).toMatch(/omitted due to size cap/);
  });

  it('reports exactly the context files that made it into the prompt', () => {
    // The orchestrator tells read_repo_context_file which files are already
    // in the system prompt. A file dropped by the size cap is NOT there, so
    // it must not be reported as embedded or the agent could never read it.
    const files = [
      { file: 'CLAUDE.md', content: 'short conventions' },
      { file: 'AGENTS.md', content: 'x'.repeat(40_000) },
    ];
    const embedded = selectEmbeddedContextFiles(files, 5_000);
    expect(embedded.map((e) => e.file)).toEqual(['CLAUDE.md']);

    const p = buildSystemPrompt({
      config: {
        ...DEFAULT_CONFIG,
        context: { ...DEFAULT_CONFIG.context, max_context_bytes: 5_000 },
      },
      repoName: 'r',
      contextFiles: files,
    });
    expect(p).toContain('short conventions');
    expect(p).not.toContain('x'.repeat(100));
    expect(p).toContain('_(1 additional context file(s) omitted due to size cap.)_');

    expect(selectEmbeddedContextFiles(files, 100_000).map((e) => e.file)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
    ]);
  });

  it('emits the static-analysis section when sast is enabled (default config)', () => {
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'r',
      contextFiles: [],
    });
    // The default config has sast.enabled = true; Sonnet should know
    // what static tools cover, expressed as POSITIVE focus areas not
    // a "don't do X" directive. The earlier directive version regressed
    // recall (Sonnet wrapped up too fast). The toned-down version frames
    // it as "here's where your judgment adds the most value".
    expect(p).toContain('Static analysis runs in parallel');
    expect(p).toContain('ESLint');
    expect(p).toContain('Semgrep');
    expect(p).toContain('Where your judgment adds the most value');
    expect(p).toContain('Semantic correctness');
    // Investigate-freely framing is the anti-regression belt — Sonnet
    // should not interpret this section as permission to skim.
    expect(p).toMatch(/investigate freely/i);
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

  it('omits architecture standards section by default and includes it when enabled', () => {
    const off = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'r',
      contextFiles: [],
    });
    expect(off).not.toContain('Software architecture standards');

    const on = buildSystemPrompt({
      config: {
        ...DEFAULT_CONFIG,
        architecture: {
          ...DEFAULT_CONFIG.architecture,
          enabled: true,
          preset: 'hexagonal',
        },
      },
      repoName: 'r',
      contextFiles: [],
    });
    expect(on).toContain('Software architecture standards');
    expect(on).toContain('**hexagonal**');

    const llmOff = buildSystemPrompt({
      config: {
        ...DEFAULT_CONFIG,
        architecture: {
          ...DEFAULT_CONFIG.architecture,
          enabled: true,
          preset: 'hexagonal',
          llm_enforcement: false,
        },
      },
      repoName: 'r',
      contextFiles: [],
    });
    expect(llmOff).not.toContain('Software architecture standards');

    // Explicit `architecture: null` (external config disabled) overrides inline enabled: true.
    const externalDisabled = buildSystemPrompt({
      config: {
        ...DEFAULT_CONFIG,
        architecture: {
          ...DEFAULT_CONFIG.architecture,
          enabled: true,
          preset: 'hexagonal',
        },
      },
      repoName: 'r',
      contextFiles: [],
      architecture: null,
    });
    expect(externalDisabled).not.toContain('Software architecture standards');
  });

  it('includes reference documentation & standards section when references corpus is provided', () => {
    const content = '# Engineering Standards\nAll handlers must validate DTOs.';
    const p = buildSystemPrompt({
      config: DEFAULT_CONFIG,
      repoName: 'r',
      contextFiles: [],
      references: {
        docs: [
          {
            id: 'docs/std.md',
            title: 'Engineering Standards',
            source: 'docs/std.md',
            kind: 'repo',
            placement: 'inline',
            content,
            byte_length: Buffer.byteLength(content),
            content_sha256: sha256Hex(content),
            headings: ['Engineering Standards'],
            truncated: false,
            cache_status: 'hit',
          },
        ],
        inline_docs: [
          {
            id: 'docs/std.md',
            title: 'Engineering Standards',
            source: 'docs/std.md',
            kind: 'repo',
            placement: 'inline',
            content,
            byte_length: Buffer.byteLength(content),
            content_sha256: sha256Hex(content),
            headings: ['Engineering Standards'],
            truncated: false,
            cache_status: 'hit',
          },
        ],
        on_demand_docs: [],
        total_inline_bytes: Buffer.byteLength(content),
        total_bytes: Buffer.byteLength(content),
        corpus_digest: 'digest',
        cache_dir: '/tmp',
        cache_stats: { hits: 1, revalidated: 0, misses: 0, stale_fallbacks: 0, uncached: 0 },
        warnings: [],
      },
    });
    expect(p).toContain('### Reference documentation & standards');
    expect(p).toContain('All handlers must validate DTOs.');
  });
});
