// Thin client for the dashboard JSON API. Shapes mirror src/local/summary.ts.

export interface RunFinding {
  severity: 'critical' | 'important' | 'minor' | 'nit' | string;
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
  target: 'working-tree' | 'range';
  base: { ref: string; sha: string | null };
  head: { ref: string; sha: string | null };
  files: number;
  additions: number;
  deletions: number;
  ended: string;
  turns: number;
  cost_usd: number;
  findings: RunFinding[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function listRuns(): Promise<RunSummary[]> {
  const data = await json<{ runs: RunSummary[] }>(await fetch('api/runs'));
  return data.runs;
}

export function getRun(id: string): Promise<RunSummary> {
  return fetch(`api/runs/${encodeURIComponent(id)}`).then((r) => json<RunSummary>(r));
}

export interface ReviewRequest {
  target?: 'auto' | 'working-tree' | 'range';
  base?: string;
  head?: string;
  model?: string;
}

export function review(req: ReviewRequest): Promise<RunSummary> {
  return fetch('api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => json<RunSummary>(r));
}
