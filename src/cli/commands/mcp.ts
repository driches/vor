import type { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('Run VOR as an MCP server over stdio (for agents like Claude Code)')
    .action(async () => {
      await startMcpServer();
    });
}
