/**
 * Persistence for local review runs. Records live under the user's home
 * dot-directory (`~/.vor/`, like `~/.claude/`) rather than inside the repo, so
 * history follows the developer across projects and never lands in a commit.
 *
 *   ~/.vor/runs/<project-slug>/<id>.json
 *
 * Layout is intentionally plain JSON files: the dashboard and CLI both read it
 * with no daemon or database, and a run is trivially inspectable by hand.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { LocalRunRecord } from './types.js';

/** Root of VOR's local state. Override with `$VOR_HOME` (used by tests). */
export function vorHome(): string {
  const override = process.env.VOR_HOME?.trim();
  return override && override.length > 0 ? resolve(override) : join(homedir(), '.vor');
}

/**
 * Stable, filesystem-safe identifier for a workspace. Combines a readable
 * basename with a short hash of the absolute path so two checkouts of the same
 * repo name in different directories don't collide.
 */
export function projectSlug(workspace: string): string {
  const abs = resolve(workspace);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  const name = basename(abs).replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
  return `${name}-${hash}`;
}

function runsDir(workspace: string): string {
  return join(vorHome(), 'runs', projectSlug(workspace));
}

/** Generate a sortable id: ISO timestamp (filesystem-safe) + random suffix. */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = createHash('sha256').update(`${ts}-${Math.random()}`).digest('hex').slice(0, 6);
  return `${ts}-${rand}`;
}

/**
 * Run ids are interpolated into a file path, so an id reaching `getRun` from
 * `vor runs show`, the dashboard, or the MCP `get_run` tool must not contain a
 * path separator that lets `../` escape the project's run directory. Generated
 * ids are only `[0-9A-Za-z-]`; allow that charset (plus `.`/`_` for headroom)
 * and reject everything else.
 */
function isValidRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export function saveRun(record: LocalRunRecord): string {
  const dir = runsDir(record.workspace);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

/**
 * List runs for a workspace, newest first. Unreadable/!malformed files are
 * skipped rather than failing the whole listing — a half-written record from a
 * crashed run shouldn't break `vor runs list`.
 */
export function listRuns(workspace: string, opts: { limit?: number } = {}): LocalRunRecord[] {
  const dir = runsDir(workspace);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  const records: LocalRunRecord[] = [];
  for (const file of ids) {
    if (opts.limit !== undefined && records.length >= opts.limit) break;
    try {
      records.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as LocalRunRecord);
    } catch {
      // Skip a malformed/partial record; don't fail the listing.
    }
  }
  return records;
}

export function getRun(workspace: string, id: string): LocalRunRecord | null {
  if (!isValidRunId(id)) return null;
  const path = join(runsDir(workspace), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LocalRunRecord;
  } catch {
    return null;
  }
}

export function latestRun(workspace: string): LocalRunRecord | null {
  return listRuns(workspace, { limit: 1 })[0] ?? null;
}
