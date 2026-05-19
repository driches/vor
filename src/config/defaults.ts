import type { ReviewConfig } from './types.js';

/**
 * Defaults applied when no .code-review.yml is present.
 * Per the plan: Sonnet 4.6, COMMENT-only (no auto-block), sticky reviews.
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
};
