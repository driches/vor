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
 *
 * Both run the orchestrator, which can load OCR/vision (src/ocr/recognize.ts),
 * so both need a real `import.meta.url`: esbuild otherwise emits
 * `import.meta = {}` for CJS output, leaving `import.meta.url` undefined — which
 * makes `createRequire(import.meta.url)` and the assetsDir resolution throw the
 * moment OCR loads. The banner defines `import_meta_url` and the `define` below
 * rewrites every `import.meta.url` to it.
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
    banner: {
      js:
        `#!/usr/bin/env node\n// driches/vor — ${label} (do not edit by hand)\n` +
        'const import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
    define: { 'import.meta.url': 'import_meta_url' },
    external: [],
  });

  // Normalise node_modules paths so the bundle is reproducible across
  // environments (git worktrees emit `../../../node_modules/…` in both the
  // `// …` comment lines and the string keys passed to __commonJS helpers).
  // Strip the leading `../` segments so output matches a regular CI checkout.
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

// Bundle the tesseract.js node worker into a single self-contained file shipped
// in assets/ocr/, shared by both the action and CLI bundles. On node,
// tesseract.js loads the OCR core via `require('tesseract.js-core/…')` inside
// this worker; esbuild inlines those emscripten loaders so the worker needs no
// node_modules at runtime. The loaders still read their `.wasm` core and
// `eng.traineddata` from disk, so the vendored cores live alongside this bundle
// (emscripten's `locateFile` resolves them relative to the worker's own
// directory). Minified so the output is reproducible (no absolute node_modules
// paths in comments).
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

console.log(`Action bundle: ${(actionBytes / 1024).toFixed(1)} KB`);
console.log(`CLI bundle:    ${(cliBytes / 1024).toFixed(1)} KB`);
console.log('OCR worker:    assets/ocr/tesseract-worker.cjs');
