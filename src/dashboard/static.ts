/**
 * Static-asset handling for the dashboard. The Svelte SPA is built by Vite to
 * `dist/dashboard/` and shipped in the npm package. At runtime we materialize it
 * under the user's home dot-dir (`~/.vor/dashboard/<version>/`) and serve from
 * there, so the served assets live alongside the rest of VOR's local state.
 */

import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { vorHome } from '../local/store.js';

/**
 * Directory of this module. In the shipped CJS bundle (dist/cli.js) `__dirname`
 * is `dist/`; under ESM (tsx dev, vitest) we derive it from import.meta.url.
 * esbuild leaves import.meta.url empty in CJS, but that branch is never taken
 * there because __dirname is defined.
 */
function thisDir(): string {
  // `typeof require` is constant-folded to true by esbuild in the CJS bundle,
  // so the import.meta.url branch is dropped there (no empty-import-meta).
  if (typeof require !== 'undefined') return __dirname;
  return fileURLToPath(new URL('.', import.meta.url));
}
const moduleDir = thisDir();

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Locate the Vite-built SPA shipped with the install. Tries the bundled layout
 * (dist/cli.js sibling `dashboard/`) first, then the repo-dev layout
 * (src/dashboard → repo `dist/dashboard`). Returns null when neither exists,
 * which means the dashboard hasn't been built yet.
 */
export function findPackagedAssets(): string | null {
  const candidates = [
    join(moduleDir, 'dashboard'), // bundled: dist/cli.js → dist/dashboard
    resolve(moduleDir, '..', '..', 'dist', 'dashboard'), // tsx dev: src/dashboard → dist/dashboard
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Copy the packaged assets into `~/.vor/dashboard/<version>` (once per version)
 * and return that directory. Throws a clear, actionable error when the SPA
 * hasn't been built.
 */
export function materializeDashboard(version: string): string {
  const packaged = findPackagedAssets();
  if (!packaged) {
    throw new Error(
      'Dashboard assets not found. Build them with `npm run build:dashboard` ' +
        '(or reinstall the published package).',
    );
  }
  const target = join(vorHome(), 'dashboard', version);
  if (!existsSync(join(target, 'index.html'))) {
    mkdirSync(target, { recursive: true });
    cpSync(packaged, target, { recursive: true });
  }
  return target;
}

/** Serve a file from `rootDir`, falling back to index.html for SPA routes. */
export function serveStatic(res: ServerResponse, rootDir: string, urlPath: string): void {
  const rel = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Resolve and confine to rootDir — reject any path that escapes it.
  const resolved = normalize(join(rootDir, rel));
  const root = normalize(rootDir);
  let filePath = resolved;
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    filePath = join(rootDir, 'index.html'); // traversal attempt → SPA shell
  } else if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    filePath = join(rootDir, 'index.html'); // unknown route → SPA shell
  }

  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}
