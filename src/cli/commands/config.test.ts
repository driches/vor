import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  workspace: { path: '' },
  out: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../output.js', () => ({
  color: (_name: string, text: string) => text,
  out: mocks.out,
  status: mocks.status,
}));

vi.mock('./shared.js', () => ({
  workspace: () => mocks.workspace.path,
}));

import { registerConfig } from './config.js';

function program(): Command {
  const command = new Command();
  command.exitOverride();
  registerConfig(command);
  return command;
}

describe('config commands', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vor-config-cli-'));
    mocks.workspace.path = workspace;
    mocks.out.mockReset();
    mocks.status.mockReset();
    writeFileSync(
      join(workspace, '.vor.yml'),
      'model: gpt-future\nproviders:\n  openai:\n    unsafe_reasoning_effort_override: future-1\n',
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('shows an unsafe override in resolved JSON and warns on stderr', async () => {
    await program().parseAsync(['node', 'vor', 'config', 'show', '--json']);

    const resolved = JSON.parse(String(mocks.out.mock.calls[0]![0])) as {
      providers: { openai: { unsafe_reasoning_effort_override?: string } };
    };
    expect(resolved.providers.openai.unsafe_reasoning_effort_override).toBe('future-1');
    expect(mocks.status).toHaveBeenCalledWith(
      expect.stringContaining('cannot validate provider/model compatibility or cost impact'),
    );
  });

  it('warns while validating an accepted unsafe override', async () => {
    await program().parseAsync(['node', 'vor', 'config', 'validate']);

    expect(mocks.status.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('unsafe_reasoning_effort_override="future-1"'),
      '.vor.yml is valid.',
    ]);
  });
});
