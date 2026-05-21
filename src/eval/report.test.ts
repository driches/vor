import { describe, expect, it } from 'vitest';
import { compare } from './compare.js';
import { fromPostedComment } from './finding.js';
import type { NormalizedFinding } from './finding.js';
import { renderReport } from './report.js';

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1..2 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 a
 b
+x
+y
 c
`;

function ourFinding(line: number, sev: 'critical' | 'important' = 'important'): NormalizedFinding {
  return fromPostedComment({
    severity: sev,
    file_path: 'src/foo.ts',
    line,
    side: 'RIGHT',
    category: 'bug',
    title: 'Null deref on user',
    why_it_matters: 'If `user` is null this throws and the request 500s.',
    suggestion: 'if (!user) return;',
    confidence: 'high',
  });
}

function codexFinding(line: number, sev: 'critical' | 'important' = 'critical'): NormalizedFinding {
  return {
    source: 'codex',
    file_path: 'src/foo.ts',
    line,
    severity: sev,
    category: 'bug',
    title: 'P1 Bug: null deref',
    body: '**P1 Bug**: null deref on user\n\nThis will crash.',
    raw: { id: 99 },
  };
}

describe('renderReport', () => {
  it('produces a Markdown report with header, aggregate, and per-case sections', () => {
    const result = compare({
      ours: [ourFinding(12)],
      codex: [codexFinding(12)],
      diff: DIFF,
    });
    const md = renderReport({
      cases: [
        {
          caseId: 'demo-1',
          prUrl: 'https://example.com/o/r/pull/1',
          owner: 'o',
          repo: 'r',
          pull_number: 1,
          result,
        },
      ],
      generatedAt: '2026-05-20T00:00:00Z',
      modelName: 'claude-sonnet-4-6',
      promptHash: 'abc1234',
    });

    expect(md).toContain('# Code-review eval report');
    expect(md).toContain('Generated: 2026-05-20T00:00:00Z');
    expect(md).toContain('Model: `claude-sonnet-4-6`');
    expect(md).toContain('Prompt hash: `abc1234`');
    expect(md).toContain('## Aggregate');
    expect(md).toContain('## demo-1 — [o/r#1]');
    expect(md).toContain('Matched pairs');
    expect(md).toContain('Severity delta');
  });

  it('renders an "Ours only" section for unmatched ours findings', () => {
    const result = compare({
      ours: [ourFinding(11), ourFinding(99)], // 99 has no match
      codex: [codexFinding(11)],
      diff: DIFF,
    });
    const md = renderReport({
      cases: [
        {
          caseId: 'demo-2',
          prUrl: 'https://example.com/o/r/pull/2',
          owner: 'o',
          repo: 'r',
          pull_number: 2,
          result,
        },
      ],
      generatedAt: '2026-05-20T00:00:00Z',
      modelName: 'claude-sonnet-4-6',
    });
    expect(md).toContain('### Ours only (1)');
    expect(md).toContain('Null deref on user'); // title shown in table
  });

  it('renders a "Codex only" section for unmatched codex findings', () => {
    const result = compare({
      ours: [],
      codex: [codexFinding(12)],
      diff: DIFF,
    });
    const md = renderReport({
      cases: [
        {
          caseId: 'demo-3',
          prUrl: 'https://example.com/o/r/pull/3',
          owner: 'o',
          repo: 'r',
          pull_number: 3,
          result,
        },
      ],
      generatedAt: '2026-05-20T00:00:00Z',
      modelName: 'claude-sonnet-4-6',
    });
    expect(md).toContain('### Codex only (1)');
    expect(md).toContain('null deref on user');
  });

  it('aggregates totals across multiple cases', () => {
    const r1 = compare({ ours: [ourFinding(12)], codex: [codexFinding(12)], diff: DIFF });
    const r2 = compare({ ours: [ourFinding(13)], codex: [], diff: DIFF });
    const md = renderReport({
      cases: [
        { caseId: 'c1', prUrl: 'u', owner: 'o', repo: 'r', pull_number: 1, result: r1 },
        { caseId: 'c2', prUrl: 'u', owner: 'o', repo: 'r', pull_number: 2, result: r2 },
      ],
      generatedAt: 't',
      modelName: 'm',
    });
    // Aggregate Ours total should be 2, Codex 1, Matched 1
    expect(md).toMatch(/\| Ours total \| 2 \|/);
    expect(md).toMatch(/\| Codex total \| 1 \|/);
    expect(md).toMatch(/\| Matched \| 1 \|/);
    // Cases row reports the actual number of cases (regression: was hardcoded '-')
    expect(md).toMatch(/\| Cases \| 2 \|/);
  });

  it('escapes pipes inside cell content', () => {
    const result = compare({
      ours: [
        {
          source: 'ours',
          file_path: 'src/a|b.ts',
          line: 12,
          severity: 'important',
          category: 'bug',
          title: 'has | pipe',
          body: 'b',
          raw: {},
        },
      ],
      codex: [],
      diff: DIFF,
    });
    const md = renderReport({
      cases: [
        { caseId: 'c', prUrl: 'u', owner: 'o', repo: 'r', pull_number: 1, result },
      ],
      generatedAt: 't',
      modelName: 'm',
    });
    expect(md).toContain('src/a\\|b.ts');
    expect(md).toContain('has \\| pipe');
  });
});
