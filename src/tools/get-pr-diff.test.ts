import { describe, expect, it } from 'vitest';
import { makeGetPrDiffTool } from './get-pr-diff.js';
import { buildFakeDeps, callTool, getResultJson, makeFile } from './test-helpers.js';

const sampleDiff = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old a
+new a
diff --git a/b.ts b/b.ts
index 3..4 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-old b
+new b
`;

describe('get_pr_diff tool', () => {
  it('returns the full diff by default', async () => {
    const deps = buildFakeDeps({
      diff: sampleDiff,
      files: [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })],
    });
    const tool = makeGetPrDiffTool(deps);
    const r = getResultJson(await callTool(tool, { max_bytes: 100_000 })) as {
      diff: string;
      truncated: boolean;
    };
    expect(r.diff).toContain('a.ts');
    expect(r.diff).toContain('b.ts');
    expect(r.truncated).toBe(false);
  });

  it('filters by paths', async () => {
    const deps = buildFakeDeps({
      diff: sampleDiff,
      files: [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })],
    });
    const tool = makeGetPrDiffTool(deps);
    const r = getResultJson(
      await callTool(tool, { paths: ['a.ts'], max_bytes: 100_000 }),
    ) as { diff: string };
    expect(r.diff).toContain('a.ts');
    expect(r.diff).not.toContain('b.ts');
  });

  it('truncates and reports omitted paths', async () => {
    const deps = buildFakeDeps({
      diff: sampleDiff,
      files: [makeFile({ path: 'a.ts' }), makeFile({ path: 'b.ts' })],
    });
    const tool = makeGetPrDiffTool(deps);
    const r = getResultJson(await callTool(tool, { max_bytes: 100 })) as {
      diff: string;
      truncated: boolean;
      omitted_paths: string[];
    };
    expect(r.truncated).toBe(true);
    expect(r.omitted_paths.length).toBeGreaterThan(0);
  });
});
