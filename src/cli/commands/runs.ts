import type { Command } from 'commander';
import { getRun, listRuns } from '../../local/store.js';
import { color, out, status } from '../output.js';
import { renderRunOneLine, renderRunRecord } from '../render.js';
import { workspace } from './shared.js';

export function registerRuns(program: Command): void {
  const runs = program.command('runs').description('Browse past local reviews (from ~/.vor/runs)');

  runs
    .command('list')
    .description('List recent runs for this project, newest first')
    .option('--limit <n>', 'Maximum number of runs to show', '20')
    .option('--json', 'Emit the run list as JSON')
    .action((flags: { limit: string; json?: boolean }) => {
      const records = listRuns(workspace(), { limit: Number.parseInt(flags.limit, 10) || 20 });
      if (flags.json) {
        out(JSON.stringify(records, null, 2));
        return;
      }
      if (records.length === 0) {
        status('No runs yet. Run `vor review` to create one.');
        return;
      }
      for (const r of records) out(renderRunOneLine(r));
    });

  runs
    .command('show <id>')
    .description('Show a single run in full')
    .option('--json', 'Emit the run record as JSON')
    .action((id: string, flags: { json?: boolean }) => {
      const record = getRun(workspace(), id);
      if (!record) {
        status(color('red', `No run found with id ${id}.`));
        process.exit(1);
      }
      out(flags.json ? JSON.stringify(record, null, 2) : renderRunRecord(record));
    });
}
