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
  const core = await getCore();
  const safe = redact(message);
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
    const core = await getCore();
    core.setSecret(s);
  },
  setOutput: async (k: string, v: string | number | boolean) => {
    const core = await getCore();
    core.setOutput(k, v);
  },
  setFailed: async (m: string) => {
    const core = await getCore();
    core.setFailed(redact(m));
  },
};
