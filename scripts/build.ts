import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

const result = await build({
  entryPoints: [resolve(rootDir, 'src/index.ts')],
  outfile: resolve(rootDir, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node\n// driches/code-review — built bundle (do not edit by hand)',
  },
  // The agent SDK uses dynamic require for native modules; mark common Node built-ins external
  external: [],
});

const totalBytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`Bundle: ${(totalBytes / 1024).toFixed(1)} KB`);
