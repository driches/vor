import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadConfigFromString, loadConfigStrict } from '../../config/loader.js';
import { color, out, status } from '../output.js';
import { workspace } from './shared.js';

function readConfigFile(configPath: string): string | null {
  try {
    return readFileSync(join(workspace(), configPath), 'utf-8');
  } catch {
    return null; // no committed config — defaults apply
  }
}

export function registerConfig(program: Command): void {
  const config = program
    .command('config')
    .description('Inspect the resolved .vor.yml configuration');

  config
    .command('show')
    .description('Print the effective config (defaults merged with .vor.yml)')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--json', 'Emit as JSON instead of YAML')
    .action((flags: { config: string; json?: boolean }) => {
      const raw = readConfigFile(flags.config);
      if (raw === null) status(color('dim', `No ${flags.config} found — showing defaults.`));
      const resolved = loadConfigFromString(raw);
      out(flags.json ? JSON.stringify(resolved, null, 2) : stringifyYaml(resolved));
    });

  config
    .command('validate')
    .description('Validate .vor.yml against the schema (exits non-zero on error)')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .action((flags: { config: string }) => {
      const raw = readConfigFile(flags.config);
      if (raw === null) {
        status(color('dim', `No ${flags.config} found — defaults are valid.`));
        return;
      }
      try {
        loadConfigStrict(raw);
        status(color('blue', `${flags.config} is valid.`));
      } catch (err) {
        status(color('red', `${flags.config} is invalid: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
