import type { Command } from 'commander';
import { startDashboard } from '../../dashboard/server.js';

export function registerDashboard(program: Command): void {
  program
    .command('dashboard')
    .description('Start the local VOR dashboard (web UI for browsing and running reviews)')
    .option('--port <n>', 'Port to listen on', '4310')
    .option('--host <host>', 'Host to bind to (loopback only)', '127.0.0.1')
    .option('--no-open', 'Do not open a browser window')
    .action(async (flags: { port: string; host: string; open: boolean }) => {
      const port = Number.parseInt(flags.port, 10) || 4310;
      await startDashboard({ port, host: flags.host, open: flags.open });
    });
}
