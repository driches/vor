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
    // Give the CJS bundle a real `import.meta.url`. esbuild otherwise emits
    // `import.meta = {}` for CJS output, leaving `import.meta.url` undefined —
    // which makes `createRequire(import.meta.url)` and the assetsDir resolution
    // in src/ocr/recognize.ts throw the moment OCR loads in the shipped Action.
    // The `define` below rewrites every `import.meta.url` to this identifier.
    js:
      '#!/usr/bin/env node\n// driches/vor — built bundle (do not edit by hand)\n' +
      'const import_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
  define: { 'import.meta.url': 'import_meta_url' },
  // tesseract.js's main thread is bundled in so the guarded dynamic import in
  // src/ocr/recognize.ts resolves with no node_modules present (the shipped
  // Action runs `node dist/index.js` directly). The worker thread can't inline
  // — it runs from an on-disk file and pulls in tesseract.js-core's emscripten
  // loaders — so it's bundled separately into assets/ocr/ below.
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

// Bundle the tesseract.js node worker into a single self-contained file shipped
// in assets/ocr/. On node, tesseract.js loads the OCR core via
// `require('tesseract.js-core/…')` inside this worker; esbuild inlines those
// emscripten loaders so the worker needs no node_modules at runtime. The
// loaders still read their `.wasm` core and `eng.traineddata` from disk, so the
// vendored cores live alongside this bundle (emscripten's `locateFile`
// resolves them relative to the worker's own directory). Minified so the output
// is reproducible (no absolute node_modules paths in comments).
const ocrAssetsDir = resolve(rootDir, 'assets', 'ocr');
await build({
  entryPoints: [resolve(rootDir, 'node_modules/tesseract.js/src/worker-script/node/index.js')],
  // `.cjs` so node runs it as CommonJS regardless of the root package's
  // "type": "module" — the worker uses `require`/`__dirname`, and the action
  // has no local package.json to override the inherited module type.
  outfile: resolve(ocrAssetsDir, 'tesseract-worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  logLevel: 'info',
});
console.log('OCR worker: assets/ocr/tesseract-worker.cjs');
