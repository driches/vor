import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');

const result = await build({
  entryPoints: [resolve(rootDir, 'src/index.ts')],
  outfile: resolve(distDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node\n// driches/vor — built bundle (do not edit by hand)',
  },
  external: [],
});

// Write a dist/package.json so Node treats the CJS bundle correctly even though
// the root package is "type": "module".
await mkdir(distDir, { recursive: true });
await writeFile(
  resolve(distDir, 'package.json'),
  JSON.stringify({ type: 'commonjs', private: true }, null, 2) + '\n',
);

// Normalise node_modules paths so the bundle is reproducible across
// environments. In a git worktree, node_modules lives in the main checkout
// rather than the worktree directory, so esbuild emits relative paths like
// `../../../node_modules/…` in BOTH the `// …` comment lines AND the string
// keys passed to __commonJS helpers. Strip the leading `../` segments from
// every occurrence so the output always matches what a regular CI checkout
// produces (`node_modules/…`).
const bundlePath = resolve(distDir, 'index.js');
const normalised = readFileSync(bundlePath, 'utf-8').replace(
  /((?:\.\.\/)+)node_modules\//g,
  'node_modules/',
);
writeFileSync(bundlePath, normalised);

const totalBytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`Bundle: ${(totalBytes / 1024).toFixed(1)} KB`);
