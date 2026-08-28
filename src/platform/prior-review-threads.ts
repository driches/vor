export interface PriorReviewReply {
  author: string;
  excerpt: string;
}

export interface PriorReviewThread {
  file_path: string;
  line: number | null;
  outdated: boolean;
  finding_excerpt: string;
  from_dismissable_review: boolean;
  already_dismissed: boolean;
  has_pushback: boolean;
  replies: PriorReviewReply[];
}

const REJECTION_PATTERNS: RegExp[] = [
  /won['’]?t\s*fix/i,
  /wont\s*fix/i,
  /won['’]?t\s*do/i,
  /wont\s*do/i,
  /by\s*design/i,
  /\bintentional/i,
  /as\s*(documented|designed|intended)/i,
  /working\s*as\s*intended/i,
  /\bwai\b/i,
  /disagree/i,
  /not\s*a\s*(real\s*)?(bug|issue|problem)/i,
];

/** Distinguish rejection from acknowledgements such as "good catch". */
export function isRejectionReply(body: string): boolean {
  const authorText = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n');
  return REJECTION_PATTERNS.some((pattern) => pattern.test(authorText));
}
