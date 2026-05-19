/**
 * Re-runs the build and fails if dist/ has uncommitted changes.
 * Ensures the committed dist/index.js matches the current src/.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

console.log('Running build...');
execSync('npm run build', { stdio: 'inherit', cwd: rootDir });

console.log('Checking dist/ is clean...');
try {
  const diff = execSync('git diff --exit-code -- dist/', { cwd: rootDir, encoding: 'utf-8' });
  if (diff.trim()) {
    console.error('dist/ is stale after build:');
    console.error(diff);
    process.exit(1);
  }
  console.log('dist/ is up to date with src/');
} catch (err: unknown) {
  const e = err as { stdout?: string; status?: number };
  if (e.status === 1 && e.stdout) {
    console.error('dist/ is stale after build. Run `npm run build` and commit dist/.');
    console.error(e.stdout);
    process.exit(1);
  }
  throw err;
}
