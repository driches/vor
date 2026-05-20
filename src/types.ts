/**
 * Shared domain types used across the agent, github, output, and tools layers.
 */

export type Severity = 'critical' | 'important' | 'minor' | 'nit';

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  important: 3,
  minor: 2,
  nit: 1,
};

export type Category =
  | 'bug'
  | 'security'
  | 'vulnerability'
  | 'data-loss'
  | 'race-condition'
  | 'error-handling'
  | 'performance'
  | 'architecture'
  | 'api-design'
  | 'test-gap'
  | 'readability'
  | 'naming'
  | 'docs'
  | 'yagni'
  | 'duplication';

/**
 * Identifier for a security scanner plugin. Used by `FindingSource` to attribute
 * scanner-originated findings.
 */
export type ScannerId = 'dependency-cve' | 'secrets' | 'sast' | 'container-cve';

/**
 * Provenance of a finding. AI-originated comments use `{ kind: 'agent', model }`;
 * scanner-originated comments use `{ kind: 'scanner', scanner, ... }`.
 */
export type FindingSource =
  | { kind: 'agent'; model: string }
  | {
      kind: 'scanner';
      scanner: ScannerId;
      rule_id?: string;
      cve_id?: string;
      ghsa_id?: string;
    };

export type Side = 'RIGHT' | 'LEFT';

export type Confidence = 'high' | 'medium' | 'low';

export type Assessment = 'approve' | 'request_changes' | 'comment';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * A range of reviewable lines [startInclusive, endInclusive].
 */
export type LineRange = readonly [number, number];

/**
 * One file in the PR — what the agent sees through `list_changed_files`.
 * `reviewable_lines` is the SINGLE SOURCE OF TRUTH for where comments may be posted.
 */
export interface ChangedFile {
  path: string;
  previous_path?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** Inclusive ranges of lines on HEAD that the agent may comment on. */
  reviewable_lines: LineRange[];
  language: string;
  is_generated: boolean;
  is_binary: boolean;
  size_bytes: number;
  /** Map of line_number → exact text on HEAD, used to verify suggestion ≠ existing line. */
  head_line_text: Map<number, string>;
}

/**
 * One inline comment accepted by the validator and queued for posting.
 * `source` is optional; absence is treated as AI-originated for backward compatibility.
 */
export interface PostedComment {
  severity: Severity;
  file_path: string;
  line: number;
  start_line?: number;
  side: Side;
  category: Category;
  title: string;
  why_it_matters: string;
  suggestion?: string;
  confidence: Confidence;
  source?: FindingSource;
}

export interface SummaryInput {
  strengths: string[];
  assessment: Assessment;
  assessment_reasoning: string;
  coverage_note?: string;
  unreviewed_paths?: string[];
}

export interface SkippedFile {
  file_path: string;
  reason: 'generated' | 'lockfile' | 'trivial-rename' | 'no-issues' | 'out-of-scope';
}

/**
 * The in-memory draft built up as the agent calls tools. Posted in a single
 * `octokit.pulls.createReview` call at the end.
 */
export interface ReviewDraft {
  comments: PostedComment[];
  summary?: SummaryInput;
  skipped: SkippedFile[];
}
