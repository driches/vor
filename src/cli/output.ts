/**
 * CLI output helpers. The `vor` binary's stdout is its user-facing deliverable
 * (review text, JSON), distinct from diagnostic logging — so it writes directly
 * to the streams rather than through the Actions-oriented logger. stderr carries
 * status/progress so stdout stays clean and pipeable (e.g. `vor review --json`).
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

export function color(name: keyof typeof codes, text: string): string {
  return useColor ? `${codes[name]}${text}${codes.reset}` : text;
}

/** Write a line to stdout (the deliverable channel). */
export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Write a status/progress line to stderr (keeps stdout clean for piping). */
export function status(line = ''): void {
  process.stderr.write(`${line}\n`);
}
