import { createRequire } from 'node:module';

/**
 * Returns the package version read from package.json at runtime.
 * Reading at runtime avoids baking the version into dist/cli.js at build time,
 * so bumping package.json doesn't invalidate the committed bundle.
 * Falls back to '0.0.0' when run from source (tests, dev) where the relative
 * path doesn't resolve.
 */
export function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
