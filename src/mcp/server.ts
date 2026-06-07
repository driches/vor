/**
 * VOR MCP server over stdio. Lets agents (e.g. Claude Code) run local reviews
 * and read run history as tools.
 *
 *   claude mcp add vor -- npx -y @driches/vor mcp
 *
 * stdout is owned by the JSON-RPC transport, so the very first thing we do is
 * route all logging to stderr (`useStderr`) — otherwise the orchestrator's
 * progress lines and secret-mask commands would corrupt the protocol stream.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { useStderr } from '../util/logger.js';
import {
  createHandlers,
  defaultDeps,
  getConfigInput,
  getRunInput,
  listRunsInput,
  reviewInput,
  type VorToolDeps,
} from './tools.js';

export function buildMcpServer(deps: VorToolDeps = defaultDeps()): McpServer {
  const server = new McpServer({ name: 'vor', version: '1.0.0' });
  const handlers = createHandlers(deps);

  server.registerTool(
    'review_local_changes',
    {
      description:
        'Run a full VOR code review (scanners + AI agent) on local changes and return findings. ' +
        'Auto-detects uncommitted working-tree changes vs a committed branch range.',
      inputSchema: reviewInput,
    },
    handlers.review_local_changes,
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List recent local VOR review runs for this project, newest first.',
      inputSchema: listRunsInput,
    },
    handlers.list_runs,
  );

  server.registerTool(
    'get_run',
    {
      description: 'Fetch a single past VOR review run by id, including all findings.',
      inputSchema: getRunInput,
    },
    handlers.get_run,
  );

  server.registerTool(
    'get_config',
    {
      description:
        'Return the resolved .vor.yml configuration (defaults merged with the repo config).',
      inputSchema: getConfigInput,
    },
    handlers.get_config,
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  useStderr(); // stdout belongs to JSON-RPC from here on.
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
