import type { ReviewConfig } from './types.js';

/**
 * Defaults applied when no .code-review.yml is present.
 * Sonnet 4.6 is the recall-default; consumers wanting cheaper review (with
 * lower recall, validated via `npm run golden:eval`) opt into Haiku 4.5 via
 * `model:` in their `.code-review.yml`. COMMENT-only (no auto-block), sticky reviews.
 */
export const DEFAULT_CONFIG: ReviewConfig = {
  model: 'claude-sonnet-4-6',
  max_turns: 40,

  exclude: {
    paths: [
      '**/*.lock',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/poetry.lock',
      '**/Cargo.lock',
      '**/Gemfile.lock',
      '**/composer.lock',
      'dist/**',
      'build/**',
      'vendor/**',
      'node_modules/**',
      '**/__generated__/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.map',
    ],
    max_diff_lines_per_file: 1500,
  },

  focus: {
    security: true,
    performance: true,
    correctness: true,
    style: false,
    tests: true,
    docs: false,
  },

  severity: {
    floor: 'minor',
    max_comments_per_file: 5,
    max_comments_total: 30,
  },

  context: {
    include: ['AGENTS.md', 'CLAUDE.md'],
    max_context_bytes: 50_000,
  },

  prompt: {
    additions: '',
  },

  review: {
    event: 'COMMENT',
    sticky: true,
    post_summary: true,
  },

  budget: {
    max_input_tokens: 500_000,
    max_output_tokens: 50_000,
  },

  security: {
    enabled: true,
    ignore_file: '.code-review/security-ignore.yml',
    scanners: {
      dependency_cve: { enabled: true },
      secrets: { enabled: true, include_generic_entropy: false },
      // v0.4.0 enables sast by default — runs the repo's own ESLint on
      // changed TS/JS files. Zero LLM token cost; catches type errors,
      // unused vars, common pitfalls before they reach Sonnet. Opt out
      // by setting `security.scanners.sast.enabled: false`.
      //
      // v0.4.1 adds an opt-in custom Semgrep ruleset alongside the
      // existing `--config=auto`. The default path points at the bundled
      // rule pack under `.code-review/semgrep-rules/` (N+1, sync-in-async,
      // raw SQL, missing auth). When the directory is absent, semgrep is
      // configured exactly as before — no behavior change for old configs.
      //
      // tsc subflag (default on) runs `tsc --noEmit` against the project
      // when tsconfig.json + node_modules/.bin/tsc are both present. Opt
      // out per-repo via `security.scanners.sast.tsc.enabled: false` (the
      // top-level `sast.enabled: false` flag still disables it along with
      // every other linter).
      sast: {
        enabled: true,
        semgrep: { custom_rules_path: '.code-review/semgrep-rules' },
        tsc: { enabled: true },
      },
      container_cve: { enabled: false },
      // coverage-delta runs the project's existing coverage tool (vitest /
      // jest / pytest-cov) and emits a finding on every PR-added line that
      // isn't exercised by the test suite. Opt-in by default — full coverage
      // runs can be slow and require the project's test deps to be installed
      // in the workspace. Enable via
      // `security.scanners.coverage_delta.enabled: true`.
      coverage_delta: { enabled: false },
      // debris, migration-safety, and dependency-hygiene are custom,
      // zero-dependency scanners that only inspect PR-added lines (and, for
      // dependency-hygiene, the manifest at HEAD). They make no network
      // calls and spawn no external binaries, so they're on by default —
      // opt out per-repo via `security.scanners.<name>.enabled: false`.
      debris: { enabled: true },
      migration_safety: { enabled: true },
      dependency_hygiene: { enabled: true },
    },
    cache: { enabled: true },
    persistence: { enabled: false },
  },

  providers: {
    openai: {},
  },

  experimental: {
    worker_delegation: {
      enabled: false,
      worker_model: 'claude-haiku-4-5',
    },
  },
};
