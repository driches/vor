/**
 * Logger that wraps @actions/core with automatic secret redaction.
 *
 * Falls back to console when @actions/core is unavailable (e.g., local dev).
 */

import { redact } from './secrets.js';

type Level = 'debug' | 'info' | 'notice' | 'warning' | 'error';

interface CoreLike {
  debug: (m: string) => void;
  info: (m: string) => void;
  notice: (m: string) => void;
  warning: (m: string) => void;
  error: (m: string) => void;
  setSecret: (s: string) => void;
  setOutput: (k: string, v: string | number | boolean) => void;
  setFailed: (m: string) => void;
}

let coreImpl: CoreLike | null = null;

/**
 * When true, all log output goes to stderr instead of @actions/core / stdout.
 * The MCP server (`vor mcp`) sets this because stdout is reserved for JSON-RPC
 * framing — a stray log line on stdout corrupts the protocol stream.
 */
let stderrOnly = false;

/** Route every subsequent log line to stderr. One-way: there is no un-set. */
export function useStderr(): void {
  stderrOnly = true;
}

async function getCore(): Promise<CoreLike> {
  if (coreImpl) return coreImpl;
  try {
    const core = await import('@actions/core');
    coreImpl = {
      debug: core.debug,
      info: core.info,
      notice: core.notice,
      warning: core.warning,
      error: core.error,
      setSecret: core.setSecret,
      setOutput: core.setOutput,
      setFailed: core.setFailed,
    };
  } catch {
    coreImpl = {
      debug: (m) => console.debug(m),
      info: (m) => console.log(m),
      notice: (m) => console.log(m),
      warning: (m) => console.warn(m),
      error: (m) => console.error(m),
      setSecret: () => {
        /* noop in non-actions context */
      },
      setOutput: (k, v) => console.log(`::set-output name=${k}::${v}`),
      setFailed: (m) => {
        console.error(m);
        process.exitCode = 1;
      },
    };
  }
  return coreImpl;
}

async function log(level: Level, message: string): Promise<void> {
  const safe = redact(message);
  if (stderrOnly) {
    // Bypass @actions/core entirely — it writes to stdout, which the MCP
    // transport owns. Keep the level as a prefix so stderr stays readable.
    process.stderr.write(`${level === 'info' ? '' : `[${level}] `}${safe}\n`);
    return;
  }
  const core = await getCore();
  core[level](safe);
}

export const logger = {
  debug: (m: string) => log('debug', m),
  info: (m: string) => log('info', m),
  notice: (m: string) => log('notice', m),
  warn: (m: string) => log('warning', m),
  error: (m: string) => log('error', m),
  /** Tells GitHub Actions to mask this string in all subsequent logs. */
  setSecret: async (s: string) => {
    // In stderr-only (MCP) mode, skip core entirely — `core.setSecret` emits a
    // `::add-mask::` workflow command on stdout, which would corrupt JSON-RPC.
    // Redaction still applies to our own log lines via `redact()`.
    if (stderrOnly) return;
    const core = await getCore();
    core.setSecret(s);
  },
  setOutput: async (k: string, v: string | number | boolean) => {
    if (stderrOnly) return; // `::set-output` would land on stdout — see setSecret.
    const core = await getCore();
    core.setOutput(k, v);
  },
  setFailed: async (m: string) => {
    if (stderrOnly) {
      process.stderr.write(`[error] ${redact(m)}\n`);
      process.exitCode = 1;
      return;
    }
    const core = await getCore();
    core.setFailed(redact(m));
  },
};
