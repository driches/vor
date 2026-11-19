import { describe, expect, it } from 'vitest';
import type { FileReader } from '../github/file-reader.js';
import { makeReadRepoContextFileTool } from './read-repo-context-file.js';
import { buildFakeDeps, callTool, getResultJson } from './test-helpers.js';

type Result = Record<string, { exists: boolean; content?: string; in_system_prompt?: boolean }>;

function recordingReader(files: Record<string, string>): {
  reader: Partial<FileReader>;
  paths: string[];
} {
  const paths: string[] = [];
  const reader: Partial<FileReader> = {
    read: async (ref) => {
      paths.push(ref.path);
      return files[ref.path] ?? null;
    },
  };
  return { reader, paths };
}

describe('read_repo_context_file tool', () => {
  it('returns content for files that exist and { exists: false } for the rest', async () => {
    const { reader } = recordingReader({ 'package.json': '{"name":"x"}' });
    const tool = makeReadRepoContextFileTool(buildFakeDeps({ fileReader: reader }));

    const r = getResultJson(await callTool(tool, { files: ['package.json', 'go.mod'] })) as Result;

    expect(r['package.json']).toEqual({ exists: true, content: '{"name":"x"}' });
    expect(r['go.mod']).toEqual({ exists: false });
  });

  it('does not repeat a file the system prompt already carries', async () => {
    // AGENTS.md / CLAUDE.md are embedded in the system prompt. Returning them
    // again puts a second copy into the message history, where it is re-read
    // (and billed) on every remaining turn of the run.
    const { reader, paths } = recordingReader({
      'AGENTS.md': '# rules',
      'CLAUDE.md': '# more rules',
      'package.json': '{"name":"x"}',
    });
    const tool = makeReadRepoContextFileTool(
      buildFakeDeps({
        fileReader: reader,
        embeddedContextFiles: new Set(['AGENTS.md', 'CLAUDE.md']),
      }),
    );

    const r = getResultJson(
      await callTool(tool, { files: ['AGENTS.md', 'CLAUDE.md', 'package.json'] }),
    ) as Result;

    expect(r['AGENTS.md']).toEqual({ exists: true, in_system_prompt: true });
    expect(r['CLAUDE.md']).toEqual({ exists: true, in_system_prompt: true });
    expect(r['package.json']).toEqual({ exists: true, content: '{"name":"x"}' });
    expect(paths).toEqual(['package.json']);
  });

  it('applies the same rule to the default "all files" call', async () => {
    const { reader, paths } = recordingReader({ 'AGENTS.md': '# rules', 'README.md': '# readme' });
    const tool = makeReadRepoContextFileTool(
      buildFakeDeps({ fileReader: reader, embeddedContextFiles: new Set(['AGENTS.md']) }),
    );

    const r = getResultJson(await callTool(tool, {})) as Result;

    expect(r['AGENTS.md']).toEqual({ exists: true, in_system_prompt: true });
    expect(r['README.md']).toEqual({ exists: true, content: '# readme' });
    expect(paths).not.toContain('AGENTS.md');
  });

  it('returns full content when nothing is embedded (eval and legacy callers)', async () => {
    const { reader } = recordingReader({ 'AGENTS.md': '# rules' });
    const tool = makeReadRepoContextFileTool(buildFakeDeps({ fileReader: reader }));

    const r = getResultJson(await callTool(tool, { files: ['AGENTS.md'] })) as Result;

    expect(r['AGENTS.md']).toEqual({ exists: true, content: '# rules' });
  });
});
