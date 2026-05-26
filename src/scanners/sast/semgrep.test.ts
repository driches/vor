import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `node:child_process` BEFORE importing the SUT so the spawn used
// inside semgrep.ts is our captured fake. Each test sets `nextScript`
// to control the child's stdout / exit code; the fake records the
// argv it was given so we can assert the `--config` flag handling.
type SpawnInvocation = { command: string; args: readonly string[] };
const spawnCalls: SpawnInvocation[] = [];
let nextScript: { stdout: string; exitCode: number } = {
  stdout: '{"results":[],"errors":[]}',
  exitCode: 0,
};

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args: [...args] });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        /* fake — never invoked when the fake closes synchronously */
      };
      // Drain stdout, then close — both async so the semgrep module
      // has a chance to attach its data/close listeners.
      const { stdout, exitCode } = nextScript;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout, 'utf-8'));
        child.emit('close', exitCode, null);
      });
      return child;
    },
  };
});

import type { ChangedFile } from '../../types.js';
import type { ScannerDeps } from '../types.js';
import { semgrepLinter, resolveCustomRulesPath } from './semgrep.js';

function makeFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    reviewable_lines: [[1, 10]],
    added_lines: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    language: 'typescript',
    is_generated: false,
    is_binary: false,
    size_bytes: 0,
    head_line_text: new Map(),
    ...over,
  };
}

function makeDeps(over: Partial<ScannerDeps> & {
  workspaceDir: string;
  customRulesPath?: string;
}): ScannerDeps {
  // Minimal deps shape — semgrep only reads `workspaceDir`, `signal`,
  // and `config.scanners.sast.semgrep.custom_rules_path`. Everything else
  // is unused by the module under test.
  return {
    workspaceDir: over.workspaceDir,
    signal: new AbortController().signal,
    config: {
      enabled: true,
      ignore_file: '.code-review/security-ignore.yml',
      scanners: {
        dependency_cve: { enabled: false },
        secrets: { enabled: false, include_generic_entropy: false },
        sast: {
          enabled: true,
          semgrep:
            over.customRulesPath !== undefined
              ? { custom_rules_path: over.customRulesPath }
              : undefined,
        },
        container_cve: { enabled: false },
      },
      cache: { enabled: false },
      persistence: { enabled: false },
    },
  } as unknown as ScannerDeps;
}

describe('semgrepLinter — custom_rules_path integration', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    nextScript = {
      stdout: '{"results":[],"errors":[]}',
      exitCode: 0,
    };
  });

  it('passes --config <abs_path> when the configured path exists on disk', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-custom-rules-'));
    try {
      const rulesDir = join(workspace, '.code-review/semgrep-rules');
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(
        join(rulesDir, 'placeholder.yml'),
        'rules: []\n',
        'utf-8',
      );

      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: '.code-review/semgrep-rules',
      });

      const result = await semgrepLinter.run(deps, [makeFile()]);

      expect(result.errors).toEqual([]);
      // Exactly one spawn — our single fake.
      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe('semgrep');
      // Auto-config still present...
      expect(call.args).toContain('--config=auto');
      // ...AND the absolute custom path appears as a separate --config flag.
      const configIdx = call.args.findIndex(
        (a, i) => a === '--config' && i + 1 < call.args.length,
      );
      expect(configIdx).toBeGreaterThanOrEqual(0);
      const customPathArg = call.args[configIdx + 1]!;
      // Absolute path resolution (relative input resolves against workspaceDir).
      expect(customPathArg.endsWith('.code-review/semgrep-rules')).toBe(true);
      expect(customPathArg.startsWith('/')).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('silently skips when custom_rules_path is set but does NOT exist on disk', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-no-rules-'));
    try {
      const deps = makeDeps({
        workspaceDir: workspace,
        // Path is set, but the directory was never created.
        customRulesPath: '.code-review/semgrep-rules',
      });

      const result = await semgrepLinter.run(deps, [makeFile()]);

      // No throw, no error, no findings.
      expect(result.errors).toEqual([]);
      expect(result.findings).toEqual([]);
      // Single spawn — but with NO custom --config flag.
      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.args).toContain('--config=auto');
      // The bare `--config` token (separate from `--config=auto`) MUST
      // NOT appear when the path is missing.
      expect(call.args.filter((a) => a === '--config')).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('skips when custom_rules_path is the empty string (explicit opt-out)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-empty-rules-'));
    try {
      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: '',
      });

      await semgrepLinter.run(deps, [makeFile()]);

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.args.filter((a) => a === '--config')).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('skips when custom_rules_path is undefined (legacy / pre-v0.4.1 config)', async () => {
    // Backwards-compat: configs that never set the field must still work
    // — semgrep just gets `--config=auto` as before.
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-undef-rules-'));
    try {
      const deps = makeDeps({ workspaceDir: workspace });

      await semgrepLinter.run(deps, [makeFile()]);

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.args.filter((a) => a === '--config')).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('emits custom-rule findings ONLY for PR-added lines', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-added-lines-'));
    try {
      mkdirSync(join(workspace, '.code-review/semgrep-rules'), { recursive: true });
      writeFileSync(
        join(workspace, '.code-review/semgrep-rules/dummy.yml'),
        'rules: []\n',
        'utf-8',
      );

      nextScript = {
        // Two findings: one ON an added line (line 3 — kept) and one
        // on a context line (line 99 — silently dropped because PR
        // didn't touch it). Same rule id for both so the only thing
        // distinguishing them is the line number.
        stdout: JSON.stringify({
          results: [
            {
              check_id: 'code-review.n-plus-one.await-in-for-loop',
              path: 'src/foo.ts',
              start: { line: 3, col: 1 },
              end: { line: 3, col: 20 },
              extra: {
                message: 'await inside for loop',
                severity: 'WARNING',
                metadata: { category: 'performance' },
              },
            },
            {
              check_id: 'code-review.n-plus-one.await-in-for-loop',
              path: 'src/foo.ts',
              start: { line: 99, col: 1 },
              end: { line: 99, col: 20 },
              extra: {
                message: 'await inside for loop',
                severity: 'WARNING',
                metadata: { category: 'performance' },
              },
            },
          ],
          errors: [],
        }),
        exitCode: 1, // semgrep exits 1 when findings exist — still parseable.
      };

      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: '.code-review/semgrep-rules',
      });

      const result = await semgrepLinter.run(deps, [
        makeFile({
          // Only lines 1-10 were touched — line 99 must be silently dropped.
          added_lines: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        }),
      ]);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.line).toBe(3);
      expect(result.findings[0]!.rule_id).toBe(
        'semgrep/code-review.n-plus-one.await-in-for-loop',
      );
      expect(result.findings[0]!.scanner).toBe('sast');
      // WARNING from a custom rule maps to "minor", as for any other
      // semgrep finding — the custom-rules code path doesn't reshape
      // severity at all.
      expect(result.findings[0]!.severity).toBe('minor');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('resolveCustomRulesPath', () => {
  // Direct-unit coverage of the resolver — the run() integration tests
  // above exercise it indirectly, but the resolver is exported and worth
  // pinning behaviorally on its own. None of these cases should ever
  // throw; missing-disk and absent-config both return null quietly.

  it('returns null when config field is undefined', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-undef-'));
    try {
      const deps = makeDeps({ workspaceDir: workspace });
      expect(await resolveCustomRulesPath(deps)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns null for the empty-string opt-out', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-empty-'));
    try {
      const deps = makeDeps({ workspaceDir: workspace, customRulesPath: '' });
      expect(await resolveCustomRulesPath(deps)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns null when the configured path does not exist on disk', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-missing-'));
    try {
      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: 'rules/no-such-dir',
      });
      expect(await resolveCustomRulesPath(deps)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns the absolute resolved path when the relative directory exists', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-rel-'));
    try {
      mkdirSync(join(workspace, 'rules/code-review'), { recursive: true });
      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: 'rules/code-review',
      });
      const result = await resolveCustomRulesPath(deps);
      expect(result).not.toBeNull();
      // Absolute, anchored at workspace.
      expect(result!.startsWith(workspace)).toBe(true);
      expect(result!.endsWith('rules/code-review')).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns an absolute path unchanged when the user supplies one', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-abs-'));
    try {
      // The absolute path IS the workspace itself (guaranteed to exist).
      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: workspace,
      });
      const result = await resolveCustomRulesPath(deps);
      expect(result).toBe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('accepts a single file path (semgrep accepts either)', async () => {
    // Operator that wants just one rule should be able to point at a
    // single .yml — semgrep's --config accepts both forms.
    const workspace = mkdtempSync(join(tmpdir(), 'semgrep-resolve-file-'));
    try {
      const rulePath = join(workspace, 'just-one.yml');
      writeFileSync(rulePath, 'rules: []\n', 'utf-8');
      const deps = makeDeps({
        workspaceDir: workspace,
        customRulesPath: 'just-one.yml',
      });
      const result = await resolveCustomRulesPath(deps);
      expect(result).toBe(rulePath);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
