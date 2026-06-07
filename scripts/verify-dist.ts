/**
 * Re-runs the build and fails if dist/ has uncommitted changes.
 * Ensures the committed dist/index.js matches the current src/.
 *
 * Also enforces that src/eval/* never ships in dist/index.js — eval code is
 * for the local golden-dataset harness and must not be bundled into the
 * GitHub Action runtime.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

console.log('Running build...');
execSync('npm run build', { stdio: 'inherit', cwd: rootDir });

console.log('Checking dist/ and the OCR worker bundle are clean...');
// The OCR worker bundle (assets/ocr/tesseract-worker.js) is build output too —
// guard it alongside dist/ so it can't drift from the installed tesseract.js.
const BUILT_PATHS = ['dist/', 'assets/ocr/tesseract-worker.cjs'];
try {
  const diff = execSync(`git diff --exit-code -- ${BUILT_PATHS.join(' ')}`, {
    cwd: rootDir,
    encoding: 'utf-8',
  });
  if (diff.trim()) {
    console.error('Build output is stale after build:');
    console.error(diff);
    process.exit(1);
  }
  console.log('dist/ and the OCR worker bundle are up to date');
} catch (err: unknown) {
  const e = err as { stdout?: string; status?: number };
  if (e.status === 1 && e.stdout) {
    console.error('Build output is stale after build. Run `npm run build` and commit the result.');
    console.error(e.stdout);
    process.exit(1);
  }
  throw err;
}

// Guard: modules that belong only to local-only / CLI surfaces must not appear
// in the action bundle. eval/* is local-only; cli/dashboard/mcp/local power the
// `vor` CLI (dist/cli.js) and must never bloat the GitHub Action runtime.
console.log('Checking dist/index.js does not include local-only modules...');
const bundlePath = resolve(rootDir, 'dist/index.js');
const bundle = readFileSync(bundlePath, 'utf-8');
const FORBIDDEN_MARKERS = [
  'src/eval/local-deps',
  'src/eval/normalize-codex',
  'src/eval/compare',
  'src/eval/report',
  'src/eval/finding',
  'src/cli/',
  'src/dashboard/',
  'src/mcp/',
  'src/local/',
];
const leaked = FORBIDDEN_MARKERS.filter((m) => bundle.includes(m));
if (leaked.length > 0) {
  console.error(
    'dist/index.js contains local-only modules — non-action code leaked into the action bundle:',
  );
  for (const m of leaked) console.error(`  - ${m}`);
  console.error(
    'Verify that src/index.ts (and its imports) never reach eval/cli/dashboard/mcp/local.',
  );
  process.exit(1);
}
console.log('dist/index.js is free of local-only modules.');
