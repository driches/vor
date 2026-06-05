import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitGrep } from './git-grep.js';

describe('runGitGrep', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vor-gitgrep-'));
    // A file with many matching lines, to exercise the output cap.
    const many = Array.from({ length: 50 }, (_, i) => `line ${i} needle`).join('\n');
    writeFileSync(join(repo, 'many.txt'), many + '\n');
    // A vendored file that an excludePaths pathspec should drop.
    mkdirSync(join(repo, 'vendor'), { recursive: true });
    writeFileSync(join(repo, 'vendor', 'skip.txt'), 'needle in vendor\n');
    // A literal `$` token, to exercise fixed-string mode.
    writeFileSync(join(repo, 'weird.ts'), 'const $cfg = load();\nuse($cfg);\n');

    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('bounds output at maxResults and flags truncation', async () => {
    const r = await runGitGrep({ pattern: 'needle', cwd: repo, maxResults: 10 });
    expect(r.matches).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('returns all matches when under the cap', async () => {
    const r = await runGitGrep({ pattern: 'in vendor', cwd: repo, maxResults: 50 });
    expect(r.matches).toHaveLength(1);
    expect(r.truncated).toBe(false);
    expect(r.matches[0]!.path).toBe('vendor/skip.txt');
  });

  it('excludes paths via :(exclude) pathspecs', async () => {
    const r = await runGitGrep({
      pattern: 'needle',
      cwd: repo,
      maxResults: 100,
      excludePaths: ['vendor'],
    });
    expect(r.matches.every((m) => !m.path.startsWith('vendor/'))).toBe(true);
    expect(r.matches.some((m) => m.path === 'many.txt')).toBe(true);
  });

  it('matches a literal $ in fixed-string mode but not as a regex anchor', async () => {
    const literal = await runGitGrep({
      pattern: '$cfg',
      cwd: repo,
      maxResults: 50,
      fixedString: true,
      wholeWord: true,
    });
    expect(literal.matches.length).toBeGreaterThan(0);

    // Under -E, `$cfg` is an end-of-line anchor followed by literal text and
    // matches nothing here — confirming why fixedString is required.
    const asRegex = await runGitGrep({ pattern: '$cfg', cwd: repo, maxResults: 50 });
    expect(asRegex.matches).toHaveLength(0);
  });

  it('returns empty on no match without throwing', async () => {
    const r = await runGitGrep({ pattern: 'zzz_no_such_token_zzz', cwd: repo, maxResults: 10 });
    expect(r.matches).toEqual([]);
  });
});
