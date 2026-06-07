/**
 * Local dashboard HTTP server (node:http, zero extra deps). Binds to loopback
 * only and additionally checks the Host header to blunt DNS-rebinding attempts,
 * because POST /api/review triggers a paid LLM call.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pkg from '../../package.json' with { type: 'json' };
import { logger } from '../util/logger.js';
import { defaultDashboardDeps, handleApi, type DashboardDeps } from './api.js';
import { materializeDashboard, serveStatic } from './static.js';

export interface DashboardOptions {
  port: number;
  host?: string;
  open?: boolean;
  /** Override the workspace + data sources (used by tests). */
  deps?: DashboardDeps;
}

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Reject requests whose Host header isn't loopback (DNS-rebinding guard). */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.replace(new RegExp(`:${port}$`), '').trim();
  return ALLOWED_HOSTS.has(name);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function startDashboard(opts: DashboardOptions): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const deps = opts.deps ?? defaultDashboardDeps(process.cwd());
  const assetDir = materializeDashboard(pkg.version);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!hostAllowed(req, opts.port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}:${opts.port}`);
      const method = req.method ?? 'GET';

      if (url.pathname.startsWith('/api/')) {
        const body = method === 'POST' ? await readBody(req) : undefined;
        const result = await handleApi(method, url.pathname, body, deps);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.body));
        return;
      }

      serveStatic(res, assetDir, url.pathname);
    })().catch((err: Error) => {
      void logger.error(`dashboard request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(opts.port, host, resolveListen);
  });

  const urlStr = `http://${host}:${opts.port}`;
  await logger.info(`VOR dashboard running at ${urlStr} (workspace: ${process.cwd()})`);
  await logger.info('Press Ctrl+C to stop.');
  if (opts.open) openBrowser(urlStr);
}

/** Best-effort browser open. Never throws — a headless box just won't open one. */
function openBrowser(url: string): void {
  // Lazy import keeps child_process out of the hot path and the type surface.
  import('node:child_process')
    .then(({ spawn }) => {
      const cmd =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
      child.on('error', () => {
        /* no browser available — ignore */
      });
      child.unref();
    })
    .catch(() => {
      /* ignore */
    });
}
