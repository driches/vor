import { describe, it, expect } from 'vitest';
import { buildUserPrompt, renderScannerFindings } from './user-prompt.js';
import type { ScanFinding } from '../scanners/types.js';

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
    const findings = [
      makeFinding({ line: 1 }),
      makeFinding({ line: 2 }),
      makeFinding({ line: 3 }),
    ];
    const out = renderScannerFindings(findings, 30);
    expect(out).toContain('(3) — already detected');
    expect(out).toContain('`src/foo.ts:1`');
    expect(out).toContain('`src/foo.ts:2`');
    expect(out).toContain('`src/foo.ts:3`');
    expect(out).not.toContain('additional');
  });

  it('caps output and announces truncation when findings exceed the budget', () => {
    // 100 findings; cap at 5. Expect the top 5 in the rendered list and a
    // truncation footer naming the remaining 95.
    const findings = Array.from({ length: 100 }, (_, i) =>
      makeFinding({ line: i + 1 }),
    );
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

describe('buildUserPrompt scanner-findings injection', () => {
  it('omits the scanner block when no findings are provided', () => {
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'code-review',
      pull_number: 1,
    });
    expect(out).not.toContain('Deterministic scanner findings');
    expect(out).toContain('Start by calling get_pr_metadata');
  });

  it('threads max_scanner_findings through to the renderer', () => {
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ line: i + 1 }),
    );
    const out = buildUserPrompt({
      owner: 'driches',
      repo: 'code-review',
      pull_number: 1,
      scanner_findings: findings,
      max_scanner_findings: 3,
    });
    expect(out).toContain('(3 shown / 50 total)');
    expect(out).toContain('47 additional');
  });
});
