import type { Command } from 'commander';
import { NothingToReviewError, runLocalReview } from '../../local/review.js';
import { saveRun } from '../../local/store.js';
import type { ReviewTarget } from '../../local/types.js';
import { out, status } from '../output.js';
import { renderRunRecord } from '../render.js';
import { requireApiKey } from './shared.js';

interface ReviewFlags {
  base?: string;
  head?: string;
  workingTree?: boolean;
  range?: boolean;
  model?: string;
  config?: string;
  json?: boolean;
  save: boolean; // commander sets this false for --no-save
}

export function registerReview(program: Command): void {
  program
    .command('review')
    .description('Review local changes (auto-detects working tree vs branch range)')
    .option('--working-tree', 'Review uncommitted changes against HEAD')
    .option('--range', 'Review a committed branch range (use with --base/--head)')
    .option('--base <ref>', 'Base ref for range mode (default: origin/main)')
    .option('--head <ref>', 'Head ref for range mode (default: HEAD)')
    .option('--model <id>', 'Override the review model')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)')
    .option('--json', 'Emit the full run record as JSON on stdout')
    .option('--no-save', 'Do not persist this run to ~/.vor/runs')
    .action(async (flags: ReviewFlags) => {
      requireApiKey();

      const target: ReviewTarget = flags.workingTree
        ? 'working-tree'
        : flags.range
          ? 'range'
          : 'auto';

      try {
        status('Reviewing… (running scanners + agent locally)');
        const record = await runLocalReview({
          target,
          ...(flags.base !== undefined ? { base: flags.base } : {}),
          ...(flags.head !== undefined ? { head: flags.head } : {}),
          ...(flags.model !== undefined ? { model: flags.model } : {}),
          ...(flags.config !== undefined ? { configPath: flags.config } : {}),
        });

        if (flags.save) {
          const path = saveRun(record);
          status(`Saved run ${record.id} → ${path}`);
        }

        if (flags.json) {
          out(JSON.stringify(record, null, 2));
        } else {
          out(renderRunRecord(record));
        }
      } catch (err) {
        if (err instanceof NothingToReviewError) {
          status(err.message);
          return; // exit 0 — nothing to review is not a failure
        }
        throw err;
      }
    });
}
