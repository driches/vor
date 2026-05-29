/**
 * Render a Markdown comparison report from one or more `CompareResult`s.
 *
 * The report is intended to live ONLY in the private golden-dataset repo
 * (it contains snippets of `body`/`title` from real code reviews). The
 * eval script is responsible for refusing to write outside GOLDEN_REPO_PATH.
 *
 * Structure:
 *   - Header (timestamp, model, prompt hash, aggregate totals)
 *   - One section per case: matched pairs, our_only, codex_only, deltas, co-occurrence
 *   - Aggregate footer (weighted agreement, combined severity-delta histogram)
 */

import type { Category, PostedComment, Severity } from '../types.js';
import { renderCommentBody } from '../github/review-poster.js';
import type { CompareResult, MatchedPair } from './compare.js';
import type { NormalizedFinding } from './finding.js';

export interface CaseReport {
  caseId: string;
  prUrl: string;
  owner: string;
  repo: string;
  pull_number: number;
  result: CompareResult;
}

export interface RenderReportInput {
  cases: CaseReport[];
  generatedAt: string;
  modelName: string;
  promptHash?: string;
}

export function renderReport(input: RenderReportInput): string {
  const lines: string[] = [];
  lines.push('# Code-review eval report');
  lines.push('');
  lines.push(`Generated: ${input.generatedAt}`);
  lines.push(`Model: \`${input.modelName}\``);
  if (input.promptHash) lines.push(`Prompt hash: \`${input.promptHash}\``);
  lines.push('');

  // Aggregate totals
  const agg = aggregate(input.cases);
  lines.push('## Aggregate');
  lines.push('');
  lines.push(formatTotalsTable(agg, input.cases.length));
  lines.push('');
  if (Object.keys(agg.severity_deltas).length > 0) {
    lines.push('### Severity delta (Codex rank − Ours rank, matched pairs only)');
    lines.push('');
    lines.push(formatSeverityDeltas(agg.severity_deltas));
    lines.push('');
  }
  if (agg.category_co_occurrence.length > 0) {
    lines.push('### Category co-occurrence (matched pairs)');
    lines.push('');
    lines.push(formatCategoryTable(agg.category_co_occurrence));
    lines.push('');
  }

  // Per-case sections
  for (const c of input.cases) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${c.caseId} — [${c.owner}/${c.repo}#${c.pull_number}](${c.prUrl})`);
    lines.push('');
    lines.push(formatTotalsLine(c.result));
    lines.push('');

    if (c.result.matched.length > 0) {
      lines.push('### Matched pairs');
      lines.push('');
      lines.push(formatMatchedTable(c.result.matched));
      lines.push('');
    }

    if (c.result.ours_only.length > 0) {
      lines.push(`### Ours only (${c.result.ours_only.length})`);
      lines.push('');
      lines.push(formatFindingsTable(c.result.ours_only));
      lines.push('');
      lines.push('<details><summary>Full bodies</summary>');
      lines.push('');
      for (const f of c.result.ours_only) {
        lines.push(formatOurFindingBody(f));
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }

    if (c.result.codex_only.length > 0) {
      lines.push(`### Codex only (${c.result.codex_only.length})`);
      lines.push('');
      lines.push(formatFindingsTable(c.result.codex_only));
      lines.push('');
      lines.push('<details><summary>Full bodies</summary>');
      lines.push('');
      for (const f of c.result.codex_only) {
        lines.push(formatCodexFindingBody(f));
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }

    if (Object.keys(c.result.severity_deltas).length > 0) {
      lines.push('### Severity delta');
      lines.push('');
      lines.push(formatSeverityDeltas(c.result.severity_deltas));
      lines.push('');
    }
  }

  return lines.join('\n');
}

interface AggregateTotals {
  ours: number;
  codex: number;
  matched: number;
  agreement_rate: number;
  severity_deltas: Record<string, number>;
  category_co_occurrence: Array<{
    ours: Category | 'unknown';
    codex: Category | 'unknown';
    count: number;
  }>;
}

function aggregate(cases: readonly CaseReport[]): AggregateTotals {
  let ours = 0;
  let codex = 0;
  let matched = 0;
  const deltas: Record<string, number> = {};
  const co = new Map<
    string,
    { ours: Category | 'unknown'; codex: Category | 'unknown'; count: number }
  >();
  for (const c of cases) {
    ours += c.result.totals.ours;
    codex += c.result.totals.codex;
    matched += c.result.totals.matched;
    for (const [k, v] of Object.entries(c.result.severity_deltas)) {
      deltas[k] = (deltas[k] ?? 0) + v;
    }
    for (const row of c.result.category_co_occurrence) {
      const key = `${row.ours}|${row.codex}`;
      const existing = co.get(key);
      if (existing) existing.count += row.count;
      else co.set(key, { ours: row.ours, codex: row.codex, count: row.count });
    }
  }
  return {
    ours,
    codex,
    matched,
    agreement_rate: ours === 0 && codex === 0 ? 1 : matched / Math.max(ours, codex),
    severity_deltas: deltas,
    category_co_occurrence: [...co.values()].sort((a, b) => b.count - a.count),
  };
}

function formatTotalsTable(agg: AggregateTotals, caseCount: number): string {
  return [
    '| Metric | Value |',
    '| --- | --- |',
    `| Cases | ${caseCount} |`,
    `| Ours total | ${agg.ours} |`,
    `| Codex total | ${agg.codex} |`,
    `| Matched | ${agg.matched} |`,
    `| Agreement rate | ${(agg.agreement_rate * 100).toFixed(1)}% |`,
  ].join('\n');
}

function formatTotalsLine(result: CompareResult): string {
  return (
    `Ours: ${result.totals.ours} · Codex: ${result.totals.codex} · ` +
    `Matched: ${result.totals.matched} · ` +
    `Agreement: ${(result.totals.agreement_rate * 100).toFixed(1)}%`
  );
}

function formatMatchedTable(pairs: readonly MatchedPair[]): string {
  const header = [
    '| File | Ours line | Codex line | Δ | Match | Ours sev | Codex sev | Title |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = pairs.map((p) => {
    const title = escapePipes(truncate(p.ours.title ?? p.codex.title ?? '', 80));
    return `| ${esc(p.ours.file_path)} | ${p.ours.line} | ${p.codex.line} | ${p.lineDistance} | ${p.matchedBy} | ${p.ours.severity} | ${p.codex.severity} | ${title} |`;
  });
  return [...header, ...rows].join('\n');
}

function formatFindingsTable(findings: readonly NormalizedFinding[]): string {
  const header = [
    '| File | Line | Severity | Category | Title |',
    '| --- | --- | --- | --- | --- |',
  ];
  const rows = findings.map(
    (f) =>
      `| ${esc(f.file_path)} | ${f.line} | ${f.severity} | ${f.category} | ${escapePipes(
        truncate(f.title ?? '', 80),
      )} |`,
  );
  return [...header, ...rows].join('\n');
}

function formatSeverityDeltas(deltas: Record<string, number>): string {
  const keys = Object.keys(deltas).sort(deltaKeySort);
  const header = ['| Delta | Count | Meaning |', '| --- | --- | --- |'];
  const rows = keys.map((k) => `| ${k} | ${deltas[k]} | ${deltaMeaning(k)} |`);
  return [...header, ...rows].join('\n');
}

function deltaKeySort(a: string, b: string): number {
  if (a === 'unknown') return 1;
  if (b === 'unknown') return -1;
  return Number(a) - Number(b);
}

function deltaMeaning(k: string): string {
  if (k === 'unknown') return 'one side had unknown severity';
  const n = Number(k);
  if (n === 0) return 'same severity';
  if (n > 0) return `Codex was ${n} rank(s) higher`;
  return `Ours was ${Math.abs(n)} rank(s) higher`;
}

function formatCategoryTable(
  rows: readonly { ours: Category | 'unknown'; codex: Category | 'unknown'; count: number }[],
): string {
  const header = ['| Ours category | Codex category | Count |', '| --- | --- | --- |'];
  const body = rows.map((r) => `| ${r.ours} | ${r.codex} | ${r.count} |`);
  return [...header, ...body].join('\n');
}

function formatOurFindingBody(f: NormalizedFinding): string {
  // The `raw` for "ours" findings is a PostedComment — render it the way GitHub would.
  const raw = f.raw as Partial<PostedComment> | undefined;
  if (raw && typeof raw === 'object' && 'severity' in raw && 'title' in raw) {
    try {
      return `**${f.file_path}:${f.line}**\n\n${renderCommentBody(raw as PostedComment)}`;
    } catch {
      // Fall through to default rendering
    }
  }
  return `**${f.file_path}:${f.line}** \`[${severityTag(f.severity)} · ${f.category}]\`\n\n${f.body}`;
}

function formatCodexFindingBody(f: NormalizedFinding): string {
  return `**${f.file_path}:${f.line}** \`[${severityTag(f.severity)} · ${f.category}]\`\n\n${f.body}`;
}

function severityTag(s: Severity | 'unknown'): string {
  return s.toUpperCase();
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
