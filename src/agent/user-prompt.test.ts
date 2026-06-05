import { describe, it, expect } from 'vitest';
import {
  buildUserPrompt,
  renderScannerFindings,
  renderPriorReviewThreads,
  renderBlastRadius,
} from './user-prompt.js';
import type { ScanFinding } from '../scanners/types.js';
import type { PriorReviewThread } from '../github/prior-review-threads.js';
import type { BlastRadiusMap } from '../context/blast-radius.js';

function makeThread(overrides: Partial<PriorReviewThread> = {}): PriorReviewThread {
  return {
    file_path: 'src/foo.ts',
    line: 10,
    outdated: false,
    finding_excerpt: '[MINOR · style] prefer const',
    from_dismissable_review: false,
    already_dismissed: false,
    has_pushback: false,
    replies: [],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ScanFinding> = {}): ScanFinding {
  return {
    scanner: 'coverage-delta',
    rule_id: 'uncovered',
    severity: 'minor',
    category: 'test-gap',
    confidence: 'medium',
    title: 'Uncovered added line',
    why_it_matters: 'Line added by this PR is not exercised by tests.',
    file_path: 'src/foo.ts',
    line: 42,
    side: 'RIGHT',
    ...overrides,
  } as ScanFinding;
}

describe('renderScannerFindings', () => {
  it('renders all findings when count is under the cap', () => {
    const findings = [makeFinding({ line: 1 }), makeFinding({ line: 2 }), makeFinding({ line: 3 })];
    const out = renderScannerFindings(findings, 30);
    expect(out).toContain('(3) — already detected');
    expect(out).toContain('scanner pipeline handles these');
    expect(out).toContain('`src/foo.ts:1`');
    expect(out).toContain('`src/foo.ts:2`');
    expect(out).toContain('`src/foo.ts:3`');
    expect(out).not.toContain('additional');
  });

  it('caps output and announces truncation when findings exceed the budget', () => {
    // 100 findings; cap at 5. Expect the top 5 in the rendered list and a
    // truncation footer naming the remaining 95.
    const findings = Array.from({ length: 100 }, (_, i) => makeFinding({ line: i + 1 }));
    const out = renderScannerFindings(findings, 5);

    expect(out).toContain('(5 shown / 100 total)');
    expect(out).toContain('`src/foo.ts:1`');
    expect(out).toContain('`src/foo.ts:5`');
    expect(out).not.toContain('`src/foo.ts:6`');
    expect(out).toContain('95 additional lower-severity scanner finding(s) omitted');
  });

  it('sorts by severity before applying the cap', () => {
    const findings = [
      makeFinding({ severity: 'minor', line: 1, title: 'minor-1' }),
      makeFinding({ severity: 'minor', line: 2, title: 'minor-2' }),
      makeFinding({ severity: 'critical', line: 99, title: 'critical-1' }),
    ];
    // Cap of 1 must keep critical, not the first minor.
    const out = renderScannerFindings(findings, 1);
    expect(out).toContain('critical-1');
    expect(out).not.toContain('minor-1');
  });

  it('treats a cap of 0 as "drop all" without crashing', () => {
    const out = renderScannerFindings([makeFinding()], 0);
    expect(out).toContain('(0 shown / 1 total)');
    expect(out).toContain('1 additional');
  });
});

describe('renderBlastRadius', () => {
  const map: BlastRadiusMap = {
    entries: [
      {
        symbol: 'verifyToken',
        defined_in: 'src/auth.ts',
        referenced_by: [
          { path: 'src/routes/login.ts', line: 12, excerpt: 'verifyToken(req.token)' },
          { path: 'src/routes/session.ts', line: 5, excerpt: 'if (!verifyToken(t))' },
        ],
        reference_count: 2,
      },
    ],
    truncated: false,
  };

  it('renders symbols with their referencing sites', () => {
    const out = renderBlastRadius(map)!;
    expect(out).toContain('Cross-file impact (blast radius)');
    expect(out).toContain('`verifyToken` (defined in src/auth.ts)');
    expect(out).toContain('src/routes/login.ts:12');
    expect(out).toContain('src/routes/session.ts:5');
  });

  it('notes when references were capped beyond what is shown', () => {
    const capped: BlastRadiusMap = {
      entries: [{ ...map.entries[0]!, reference_count: 9 }],
      truncated: true,
    };
    const out = renderBlastRadius(capped)!;
    expect(out).toContain('+7 more file(s)');
  });

  it('returns null for an empty map so the block is omitted', () => {
    expect(renderBlastRadius({ entries: [], truncated: false })).toBeNull();
  });

  it('honors the byte cap by dropping entries past the budget', () => {
    const many: BlastRadiusMap = {
      entries: Array.from({ length: 50 }, (_, i) => ({
        symbol: `symbol_number_${i}`,
        defined_in: `src/module-${i}.ts`,
        referenced_by: [{ path: `src/caller-${i}.ts`, line: i, excerpt: 'x' }],
        reference_count: 1,
      })),
      truncated: false,
    };
    const full = renderBlastRadius(many, 100_000)!;
    const capped = renderBlastRadius(many, 1_200)!;
    expect(capped.length).toBeLessThan(full.length);
    // Header + early entries survive; later entries are dropped past the budget.
    expect(capped).toContain('Cross-file impact (blast radius)');
    expect(capped).toContain('`symbol_number_0`');
    expect(capped).not.toContain('`symbol_number_49`');
    expect(capped).toContain('this is a bounded sample');
    expect(full).toContain('`symbol_number_49`');
  });
});

describe('buildUserPrompt blast-radius injection', () => {
  it('omits the block when no map is provided', () => {
    const out = buildUserPrompt({ owner: 'driches', repo: 'vor', pull_number: 1 });
    expect(out).not.toContain('Cross-file impact');
  });

  it('injects the block when the map has entries', () => {
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'vor',
      pull_number: 1,
      blast_radius: {
        entries: [
          {
            symbol: 'verifyToken',
            defined_in: 'src/auth.ts',
            referenced_by: [{ path: 'src/routes/login.ts', line: 12, excerpt: 'x' }],
            reference_count: 1,
          },
        ],
        truncated: false,
      },
    });
    expect(out).toContain('Cross-file impact (blast radius)');
    expect(out).toContain('`verifyToken`');
    expect(out).toContain('Start by calling get_pr_metadata');
  });

  it('omits the block when the map is present but empty', () => {
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'vor',
      pull_number: 1,
      blast_radius: { entries: [], truncated: false },
    });
    expect(out).not.toContain('Cross-file impact');
  });
});

describe('buildUserPrompt scanner-findings injection', () => {
  it('omits the scanner block when no findings are provided', () => {
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'vor',
      pull_number: 1,
    });
    expect(out).not.toContain('Deterministic scanner findings');
    expect(out).toContain('Start by calling get_pr_metadata');
  });

  it('threads max_scanner_findings through to the renderer', () => {
    const findings = Array.from({ length: 50 }, (_, i) => makeFinding({ line: i + 1 }));
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'vor',
      pull_number: 1,
      scanner_findings: findings,
      max_scanner_findings: 3,
    });
    expect(out).toContain('(3 shown / 50 total)');
    expect(out).toContain('47 additional');
  });
});

describe('renderPriorReviewThreads', () => {
  it('renders findings and author replies with the dedup/pushback rules', () => {
    const out = renderPriorReviewThreads([
      makeThread({
        file_path: 'src/auth.ts',
        line: 42,
        finding_excerpt: '[CRITICAL · security] SQL injection',
        replies: [{ author: 'author', excerpt: "Won't fix — by design." }],
      }),
    ]);
    expect(out).toContain('Your prior review threads on this PR (1)');
    expect(out).toContain('`src/auth.ts:42`');
    expect(out).toContain('[CRITICAL · security] SQL injection');
    expect(out).toContain('reply from @author: "Won\'t fix — by design."');
    expect(out).toContain('Do NOT re-post');
    expect(out).toContain('NOT areas to skip');
  });

  it('sorts threads with author replies ahead of unanswered ones', () => {
    const out = renderPriorReviewThreads([
      makeThread({ file_path: 'a.ts', finding_excerpt: 'no-reply finding', replies: [] }),
      makeThread({
        file_path: 'z.ts',
        finding_excerpt: 'replied finding',
        replies: [{ author: 'author', excerpt: 'disagree' }],
      }),
    ]);
    expect(out.indexOf('replied finding')).toBeLessThan(out.indexOf('no-reply finding'));
  });

  it('keeps a genuinely pushed-back thread ahead of an acknowledgement under the cap', () => {
    const out = renderPriorReviewThreads(
      [
        makeThread({
          file_path: 'a.ts',
          finding_excerpt: 'ack only',
          replies: [{ author: 'x', excerpt: 'good catch' }],
          has_pushback: false,
        }),
        makeThread({
          file_path: 'z.ts',
          finding_excerpt: 'rejected finding',
          replies: [{ author: 'x', excerpt: 'wontfix' }],
          has_pushback: true,
        }),
      ],
      1,
    );
    // cap=1: the rejected thread must survive, not the mere acknowledgement.
    expect(out).toContain('rejected finding');
    expect(out).not.toContain('ack only');
  });

  it('marks outdated threads and renders a path without a line', () => {
    const out = renderPriorReviewThreads([
      makeThread({ file_path: 'src/x.ts', line: null, outdated: true }),
    ]);
    expect(out).toContain('`src/x.ts`');
    expect(out).toContain('outdated — author pushed past this line');
  });

  it('caps threads and announces truncation', () => {
    const threads = Array.from({ length: 40 }, (_, i) => makeThread({ line: i + 1 }));
    const out = renderPriorReviewThreads(threads, 5);
    expect(out).toContain('(5 shown / 40 total)');
    expect(out).toContain('35 additional prior thread(s) omitted');
  });

  it('caps replies per thread and notes how many were omitted', () => {
    const replies = Array.from({ length: 9 }, (_, i) => ({
      author: 'author',
      excerpt: `reply ${i + 1}`,
    }));
    const out = renderPriorReviewThreads([makeThread({ replies })]);
    // First 5 kept (earliest = strongest pushback signal), rest summarized.
    expect(out).toContain('reply 1');
    expect(out).toContain('reply 5');
    expect(out).not.toContain('reply 6');
    expect(out).toContain('(+4 more replies in this thread, omitted)');
  });

  it('uses singular "reply" when exactly one reply is omitted', () => {
    const replies = Array.from({ length: 6 }, (_, i) => ({
      author: 'author',
      excerpt: `reply ${i + 1}`,
    }));
    const out = renderPriorReviewThreads([makeThread({ replies })]);
    expect(out).toContain('(+1 more reply in this thread, omitted)');
  });
});

describe('buildUserPrompt prior-threads injection', () => {
  it('omits the prior-threads block when none are provided', () => {
    const out = buildUserPrompt({ owner: 'driches', repo: 'vor', pull_number: 1 });
    expect(out).not.toContain('Your prior review threads');
  });

  it('injects the prior-threads block and threads the cap through', () => {
    const threads = Array.from({ length: 10 }, (_, i) => makeThread({ line: i + 1 }));
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'vor',
      pull_number: 1,
      prior_threads: threads,
      max_prior_threads: 4,
    });
    expect(out).toContain('(4 shown / 10 total)');
    expect(out).toContain('Start by calling get_pr_metadata');
  });
});
