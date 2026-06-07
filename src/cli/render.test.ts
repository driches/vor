import { describe, expect, it } from 'vitest';
import type { LocalRunRecord } from '../local/types.js';
import { renderRunOneLine, renderRunRecord } from './render.js';

// NO_COLOR keeps assertions free of ANSI escapes.
process.env.NO_COLOR = '1';

function record(comments: LocalRunRecord['result']['kept_comments']): LocalRunRecord {
  return {
    id: 'run-1',
    timestamp: '2026-06-07T00:00:00.000Z',
    target: 'working-tree',
    base: { ref: 'HEAD', sha: 'a'.repeat(40) },
    head: { ref: 'working-tree', sha: null },
    workspace: '/ws',
    project_slug: 'ws-1234abcd',
    config_path: '.vor.yml',
    files: 1,
    additions: 4,
    deletions: 0,
    result: {
      comment_count: comments.length,
      ended: 'summary_posted',
      turns: 3,
      cost_usd: 0.0123,
      dry_run: true,
      kept_comments: comments,
    },
  };
}

describe('CLI render', () => {
  it('renders a clean run', () => {
    const text = renderRunRecord(record([]));
    expect(text).toContain('working tree vs HEAD');
    expect(text).toContain('No findings.');
    expect(text).toContain('run-1');
  });

  it('renders findings grouped with file:line and suggestion', () => {
    const text = renderRunRecord(
      record([
        {
          severity: 'critical',
          file_path: 'src/x.ts',
          line: 42,
          side: 'RIGHT',
          category: 'security',
          title: 'SQL injection',
          why_it_matters: 'User input is concatenated into a query.',
          suggestion: 'use parameters',
          confidence: 'high',
        },
      ]),
    );
    expect(text).toContain('[critical]');
    expect(text).toContain('src/x.ts:42');
    expect(text).toContain('SQL injection');
    expect(text).toContain('suggested fix:');
    expect(text).toContain('1 critical');
  });

  it('renders a one-line summary', () => {
    const line = renderRunOneLine(record([]));
    expect(line).toContain('run-1');
    expect(line).toContain('worktree');
    expect(line).toContain('clean');
  });
});
