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

  it('applies the default max_bytes (100k) when omitted, truncating a large diff', async () => {
    // Regression: the schema declares `max_bytes: ...default(100_000)`. Before
    // the tool() helper parsed input, an omitted `max_bytes` arrived as
    // undefined, so `diff.length > undefined` was always false and the diff was
    // never truncated — the agent could be handed an unbounded payload.
    const bigDiff =
      `diff --git a/big.ts b/big.ts\nindex 1..2 100644\n--- a/big.ts\n+++ b/big.ts\n` +
      `@@ -1 +1 @@\n+${'x'.repeat(150_000)}\n` +
      `diff --git a/small.ts b/small.ts\nindex 3..4 100644\n--- a/small.ts\n+++ b/small.ts\n@@ -1 +1 @@\n+y\n`;
    const deps = buildFakeDeps({
      diff: bigDiff,
      files: [makeFile({ path: 'big.ts' }), makeFile({ path: 'small.ts' })],
    });
    const tool = makeGetPrDiffTool(deps);
    const r = getResultJson(await callTool(tool, {})) as {
      diff: string;
      truncated: boolean;
    };
    expect(r.truncated).toBe(true);
    expect(r.diff.length).toBeLessThanOrEqual(100_000);
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
