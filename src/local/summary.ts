/**
 * Compact projection of a LocalRunRecord — the shape the dashboard API and MCP
 * tools hand back to consumers. Keeps `kept_comments` (the eval contract) intact
 * on disk while exposing a flatter, agent/UI-friendly view.
 */

import type { LocalRunRecord } from './types.js';

export interface RunFinding {
  severity: string;
  file: string;
  line: number;
  category: string;
  title: string;
  why: string;
  suggestion?: string;
}

export interface RunSummary {
  id: string;
  timestamp: string;
  target: LocalRunRecord['target'];
  base: LocalRunRecord['base'];
  head: LocalRunRecord['head'];
  files: number;
  additions: number;
  deletions: number;
  ended: string;
  turns: number;
  cost_usd: number;
  findings: RunFinding[];
}

export function summarizeRun(record: LocalRunRecord): RunSummary {
  return {
    id: record.id,
    timestamp: record.timestamp,
    target: record.target,
    base: record.base,
    head: record.head,
    files: record.files,
    additions: record.additions,
    deletions: record.deletions,
    ended: record.result.ended,
    turns: record.result.turns,
    cost_usd: record.result.cost_usd,
    findings: record.result.kept_comments.map((c) => ({
      severity: c.severity,
      file: c.file_path,
      line: c.line,
      category: c.category,
      title: c.title,
      why: c.why_it_matters,
      ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}),
    })),
  };
}
