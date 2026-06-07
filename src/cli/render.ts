/**
 * Render a LocalRunRecord for the terminal: a header with provenance + cost,
 * then findings grouped by severity (critical → nit), each anchored to
 * file:line with its rationale and any suggested fix.
 */

import type { Severity } from '../types.js';
import type { PostedComment } from '../types.js';
import type { LocalRunRecord } from '../local/types.js';
import { color } from './output.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'important', 'minor', 'nit'];

const SEVERITY_COLOR: Record<Severity, Parameters<typeof color>[0]> = {
  critical: 'red',
  important: 'yellow',
  minor: 'blue',
  nit: 'gray',
};

function severityCounts(comments: ReadonlyArray<PostedComment>): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, important: 0, minor: 0, nit: 0 };
  for (const c of comments) counts[c.severity] += 1;
  return counts;
}

export function renderRunRecord(record: LocalRunRecord): string {
  const lines: string[] = [];
  const { result } = record;
  const targetLabel =
    record.target === 'working-tree'
      ? `working tree vs ${record.base.ref}`
      : `${record.base.ref} → ${record.head.ref}`;

  lines.push(color('bold', `VOR review — ${targetLabel}`));
  lines.push(
    color(
      'dim',
      `${record.files} file(s), +${record.additions}/-${record.deletions} · ` +
        `${result.turns} turn(s) · $${result.cost_usd.toFixed(4)} · ${result.ended}`,
    ),
  );

  const comments = result.kept_comments;
  if (comments.length === 0) {
    lines.push('');
    lines.push(color('dim', 'No findings.'));
    lines.push('');
    lines.push(color('dim', `run id: ${record.id}`));
    return lines.join('\n');
  }

  const counts = severityCounts(comments);
  const summaryBits = SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) =>
    color(SEVERITY_COLOR[s], `${counts[s]} ${s}`),
  );
  lines.push('');
  lines.push(summaryBits.join('  '));

  for (const sev of SEVERITY_ORDER) {
    const group = comments.filter((c) => c.severity === sev);
    if (group.length === 0) continue;
    for (const c of group) {
      lines.push('');
      const tag = color(SEVERITY_COLOR[sev], `[${sev}]`);
      lines.push(`${tag} ${color('bold', c.title)}  ${color('dim', `${c.file_path}:${c.line}`)}`);
      lines.push(`  ${c.why_it_matters}`);
      if (c.suggestion) {
        lines.push(color('dim', '  suggested fix:'));
        for (const sline of c.suggestion.split('\n')) lines.push(color('dim', `    ${sline}`));
      }
    }
  }

  lines.push('');
  lines.push(color('dim', `run id: ${record.id}`));
  return lines.join('\n');
}

/** One-line summary for `vor runs list`. */
export function renderRunOneLine(record: LocalRunRecord): string {
  const counts = severityCounts(record.result.kept_comments);
  const findings = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]}${s[0]}`)
    .join(' ');
  const targetLabel =
    record.target === 'working-tree' ? 'worktree' : `${record.base.ref}→${record.head.ref}`;
  return (
    `${color('dim', record.timestamp)}  ${record.id}  ` +
    `${targetLabel}  ${findings || color('dim', 'clean')}  ` +
    color('dim', `$${record.result.cost_usd.toFixed(4)}`)
  );
}
