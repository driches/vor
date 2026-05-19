import type { Severity, ReviewEvent } from '../types.js';

export interface ReviewConfig {
  model: string;
  max_turns: number;

  exclude: {
    paths: string[];
    max_diff_lines_per_file: number;
  };

  focus: {
    security: boolean;
    performance: boolean;
    correctness: boolean;
    style: boolean;
    tests: boolean;
    docs: boolean;
  };

  severity: {
    floor: Severity;
    max_comments_per_file: number;
    max_comments_total: number;
  };

  context: {
    include: string[];
    max_context_bytes: number;
  };

  prompt: {
    additions: string;
  };

  review: {
    event: ReviewEvent;
    sticky: boolean;
    post_summary: boolean;
  };

  budget: {
    max_input_tokens: number;
    max_output_tokens: number;
  };
}
