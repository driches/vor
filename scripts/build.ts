import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

/**
 * Two self-contained CJS bundles share this dist/:
 *   - index.js: the GitHub Action runtime (entry src/index.ts).
 *   - cli.js:   the `vor` local CLI (entry src/cli/index.ts) — review,
 *               dashboard, and MCP. Never imported by index.ts, so the action
 *               bundle stays lean (enforced by scripts/verify-dist.ts).
 */
async function bundle(entry: string, outName: string, label: string): Promise<number> {
  const result = await build({
    entryPoints: [resolve(rootDir, entry)],
    outfile: resolve(distDir, outName),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: false,
    sourcemap: false,
    metafile: true,
    logLevel: 'info',
    // import.meta.url appears only in ESM-only fallback branches that the CJS
    // bundle never executes (they're guarded by __dirname/require checks). The
    // empty value esbuild substitutes is therefore never read.
    logOverride: { 'empty-import-meta': 'silent' },
    banner: {
      js: `#!/usr/bin/env node\n// driches/vor — ${label} (do not edit by hand)`,
    },
    external: [],
  });

  // Normalise node_modules paths so the bundle is reproducible across
  // environments (git worktrees emit `../../../node_modules/…`). Strip the
  // leading `../` segments so output matches a regular CI checkout.
  const bundlePath = resolve(distDir, outName);
  const normalised = readFileSync(bundlePath, 'utf-8').replace(
    /((?:\.\.\/)+)node_modules\//g,
    'node_modules/',
  );
  writeFileSync(bundlePath, normalised);

  return Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
}

await mkdir(distDir, { recursive: true });

const actionBytes = await bundle('src/index.ts', 'index.js', 'action bundle');
const cliBytes = await bundle('src/cli/index.ts', 'cli.js', 'CLI bundle');

// Write a dist/package.json so Node treats the CJS bundles correctly even though
// the root package is "type": "module".
await writeFile(
  resolve(distDir, 'package.json'),
  JSON.stringify({ type: 'commonjs', private: true }, null, 2) + '\n',
);

console.log(`Action bundle: ${(actionBytes / 1024).toFixed(1)} KB`);
console.log(`CLI bundle:    ${(cliBytes / 1024).toFixed(1)} KB`);
