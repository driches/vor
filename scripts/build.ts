import { build } from 'esbuild';
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

const totalBytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`Bundle: ${(totalBytes / 1024).toFixed(1)} KB`);
