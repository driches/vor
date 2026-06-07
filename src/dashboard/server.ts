/**
 * Local dashboard HTTP server (node:http, zero extra deps). Binds to loopback
 * only and additionally checks the Host header to blunt DNS-rebinding attempts,
 * because POST /api/review triggers a paid LLM call.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pkg from '../../package.json' with { type: 'json' };
import { repoRoot } from '../local/git.js';
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

/** Addresses the server may bind to. The Host-header guard is client-controlled
 *  (a LAN client can spoof `Host: localhost`), so the real protection is binding
 *  to loopback in the first place. */
const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);

/** Refuse to bind anywhere a LAN/WAN peer could reach: the dashboard has no auth
 *  and POST /api/review triggers a paid LLM call. */
function assertLoopbackBind(host: string): void {
  if (!LOOPBACK_BIND.has(host)) {
    throw new Error(
      `Refusing to bind the dashboard to non-loopback host "${host}". It has no ` +
        `auth and POST /api/review triggers a paid LLM call, so it serves ` +
        `loopback only (127.0.0.1, ::1, localhost).`,
    );
  }
}

/** Allow a request Origin only when absent (non-browser clients like the CLI or
 *  curl) or a same-origin loopback value. A foreign Origin is rejected. */
function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(origin);
}

/**
 * CSRF check for state-changing API requests. A malicious page can make the
 * browser POST to loopback with a simple form, but it cannot set
 * `Content-Type: application/json` (that forces a CORS preflight we never
 * approve) nor a same-origin Origin. Require both, so a drive-by POST can't
 * trigger a paid review. GET is read-only and the same-origin policy already
 * blocks reading responses cross-site. Returns a rejection or null (allowed).
 */
export function csrfRejection(
  method: string,
  headers: { contentType?: string; origin?: string },
  port: number,
): { status: number; message: string } | null {
  if (method === 'GET') return null;
  if (!(headers.contentType ?? '').includes('application/json')) {
    return { status: 415, message: 'Unsupported Media Type: send application/json' };
  }
  if (!originAllowed(headers.origin, port)) {
    return { status: 403, message: 'Forbidden: cross-origin request' };
  }
  return null;
}

/** Bracket an IPv6 literal (e.g. `::1` → `[::1]`) so it's valid in an HTTP URL
 *  authority. IPv4 / hostnames pass through unchanged. */
export function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

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
  assertLoopbackBind(host); // before anything else — never bind externally
  const authority = `${hostForUrl(host)}:${opts.port}`;
  // Read history under the repo root so it matches the slug runLocalReview saves
  // to (it normalizes to the root); otherwise a review started from a nested dir
  // would never appear in /api/runs.
  const deps = opts.deps ?? defaultDashboardDeps(repoRoot(process.cwd()));
  const assetDir = materializeDashboard(pkg.version);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!hostAllowed(req, opts.port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${authority}`);
      const method = req.method ?? 'GET';

      if (url.pathname.startsWith('/api/')) {
        const rejection = csrfRejection(
          method,
          { contentType: req.headers['content-type'], origin: req.headers.origin },
          opts.port,
        );
        if (rejection) {
          res.writeHead(rejection.status, { 'Content-Type': 'text/plain' });
          res.end(rejection.message);
          return;
        }
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

  const urlStr = `http://${authority}`;
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
