import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPipelineConfig } from './config-loader.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-config-test-'));
}

describe('loadPipelineConfig', () => {
  it('loads a full config and merges with DEFAULT_CONFIG', () => {
    const dir = makeTempDir();
    const path = join(dir, 'sonnet-only.yml');
    writeFileSync(
      path,
      [
        'model: claude-sonnet-4-6',
        'max_turns: 40',
        'severity:',
        '  floor: minor',
        '  max_comments_per_file: 5',
        '  max_comments_total: 30',
        'budget:',
        '  max_input_tokens: 500000',
        '  max_output_tokens: 50000',
      ].join('\n'),
    );
    const cfg = loadPipelineConfig(path);
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.max_turns).toBe(40);
    expect(cfg.severity.floor).toBe('minor');
    expect(cfg.budget.max_input_tokens).toBe(500000);
    // Fields not in the partial config come from DEFAULT_CONFIG.
    expect(cfg.review.event).toBe('COMMENT');
    rmSync(dir, { recursive: true });
  });

  it('accepts a minimal config (just model) and fills the rest from defaults', () => {
    const dir = makeTempDir();
    const path = join(dir, 'minimal.yml');
    writeFileSync(path, 'model: claude-haiku-4-5');
    const cfg = loadPipelineConfig(path);
    expect(cfg.model).toBe('claude-haiku-4-5');
    expect(cfg.max_turns).toBe(40); // from DEFAULT_CONFIG
    expect(cfg.severity.floor).toBe('minor');
    rmSync(dir, { recursive: true });
  });

  it('throws a descriptive error on malformed YAML', () => {
    const dir = makeTempDir();
    const path = join(dir, 'bad.yml');
    writeFileSync(path, ': not : valid : yaml :');
    expect(() => loadPipelineConfig(path)).toThrow(/parse|invalid/i);
    rmSync(dir, { recursive: true });
  });

  it('throws a descriptive error on schema violation', () => {
    const dir = makeTempDir();
    const path = join(dir, 'bad-schema.yml');
    writeFileSync(path, 'severity:\n  floor: NOT_A_REAL_SEVERITY');
    expect(() => loadPipelineConfig(path)).toThrow(/floor|enum/i);
    rmSync(dir, { recursive: true });
  });
});
