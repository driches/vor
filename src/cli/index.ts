/**
 * `vor` CLI entry point. Bundled separately to dist/cli.js (never part of the
 * GitHub Action bundle, dist/index.js). Wires the local-review core, dashboard,
 * and MCP server behind a single binary.
 */

import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { useStderr } from '../util/logger.js';
import { packageVersion } from '../util/package-version.js';
import { status } from './output.js';
import { registerConfig } from './commands/config.js';
import { registerDashboard } from './commands/dashboard.js';
import { registerMcp } from './commands/mcp.js';
import { registerReview } from './commands/review.js';
import { registerRuns } from './commands/runs.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('vor')
    .description('VOR — local AI code review: review, dashboard, and MCP for your working tree')
    .version(packageVersion(), '-v, --version');

  registerReview(program);
  registerRuns(program);
  registerConfig(program);
  registerDashboard(program);
  registerMcp(program);

  return program;
}

export async function main(): Promise<void> {
  // The CLI's stdout is its deliverable (review render, `--json`, config YAML),
  // written via output.ts. The orchestrator logs progress through logger.info,
  // which otherwise lands on stdout (@actions/core / console.log) and corrupts
  // `vor review --json | jq`. Pin all logging to stderr for every command.
  useStderr();
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

/** True only when this module is the process entry point (the `vor` binary),
 *  not when it's imported (e.g. by tests). Handles both the shipped CJS bundle
 *  (require.main === module) and the ESM dev/test path (import.meta.url). */
function invokedDirectly(): boolean {
  if (typeof require !== 'undefined' && typeof module !== 'undefined') {
    return require.main === module;
  }
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err: Error) => {
    status(err.stack ?? err.message);
    process.exit(1);
  });
}
