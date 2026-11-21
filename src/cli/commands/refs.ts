/**
 * `vor refs` CLI command group — inspect, sync, view, and clear cached
 * reference documentation & engineering standards.
 */

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isSafeRelativePath } from '../../architecture/loader.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { loadConfigStrict } from '../../config/loader.js';
import type { ReviewConfig } from '../../config/types.js';
import { createOctokit } from '../../github/client.js';
import {
  DiskReferenceCache,
  resolveReferenceCacheDir,
  type ReferenceCacheMeta,
} from '../../references/cache.js';
import { loadReferences, type LoadedReferenceCorpus } from '../../references/loader.js';
import { color, out, status } from '../output.js';
import { workspace } from './shared.js';

function loadWorkspaceReviewConfigOrExit(ws: string, configPath: string): ReviewConfig {
  if (!isSafeRelativePath(ws, configPath)) {
    status(color('red', `Config path '${configPath}' escapes workspace root.`));
    process.exit(2);
  }
  let raw: string | null = null;
  try {
    raw = readFileSync(resolve(ws, configPath), 'utf-8');
  } catch {
    return DEFAULT_CONFIG; // missing .vor.yml uses defaults
  }
  try {
    return loadConfigStrict(raw);
  } catch (err) {
    status(color('red', `Invalid ${configPath}: ${(err as Error).message}`));
    process.exit(2);
  }
}

function optionalGithubOctokit() {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token ? createOctokit({ auth: token }) : undefined;
}

function formatAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function renderRefsSync(corpus: LoadedReferenceCorpus): string {
  const lines: string[] = [];
  lines.push(color('bold', 'VOR reference documentation sync'));
  lines.push(
    color('dim', `cache dir: ${corpus.cache_dir} · digest: ${corpus.corpus_digest.slice(0, 12)}`),
  );
  const estInlineTokens = Math.round(corpus.total_inline_bytes / 4);
  lines.push(
    `Loaded ${corpus.docs.length} doc(s) (${corpus.inline_docs.length} inline ~${estInlineTokens} est. tokens / ${corpus.total_inline_bytes} bytes, ${corpus.on_demand_docs.length} on-demand)`,
  );
  lines.push(
    color(
      'dim',
      `cache stats: ${corpus.cache_stats.hits} hit, ${corpus.cache_stats.revalidated} revalidated, ` +
        `${corpus.cache_stats.misses} fetched/written, ${corpus.cache_stats.stale_fallbacks} stale-fallback`,
    ),
  );

  if (corpus.docs.length === 0) {
    lines.push('');
    lines.push('No reference documents loaded.');
    return lines.join('\n');
  }

  for (const d of corpus.docs) {
    lines.push('');
    lines.push(
      `  ${color('bold', d.id)}  ${color('dim', `[${d.kind} · ${d.placement} · ${d.cache_status} · ${d.byte_length}B]`)}`,
    );
    lines.push(`    ${d.title} (${d.content_sha256.slice(0, 10)})`);
  }
  return lines.join('\n');
}

export function renderRefsStatus(info: {
  enabled: boolean;
  configured_sources: number;
  cache_dir: string;
  entries: ReferenceCacheMeta[];
  nowMs?: number;
}): string {
  const nowMs = info.nowMs ?? Date.now();
  const lines: string[] = [];
  lines.push(color('bold', 'VOR reference cache status'));
  lines.push(
    color(
      'dim',
      `enabled: ${info.enabled} · configured sources: ${info.configured_sources} · dir: ${info.cache_dir}`,
    ),
  );

  if (info.entries.length === 0) {
    lines.push('');
    lines.push('Reference cache is empty.');
    return lines.join('\n');
  }

  for (const e of info.entries) {
    const ageSec = Math.max(0, (nowMs - Date.parse(e.fetched_at)) / 1000);
    const fresh = ageSec < e.ttl_seconds;
    const stateLabel = fresh ? color('blue', 'fresh') : color('yellow', 'stale');
    const etagNote = e.etag ? ' · etag' : '';
    lines.push('');
    lines.push(
      `  ${stateLabel}  ${color('bold', e.source_id)}  ${color('dim', `[${e.kind} · ${e.byte_length}B · age ${formatAgeSeconds(ageSec)} / ttl ${formatAgeSeconds(e.ttl_seconds)}${etagNote}]`)}`,
    );
    lines.push(color('dim', `    ${e.key} (${e.content_sha256.slice(0, 10)})`));
  }
  return lines.join('\n');
}

export function registerRefs(program: Command): void {
  const refs = program
    .command('refs')
    .description('Manage reference documentation and standards (sync, cache status, show, clear)');

  refs
    .command('sync')
    .description('Load configured reference documentation sources and populate the disk cache')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--refresh', 'Bypass fresh TTLs and re-fetch/revalidate all sources')
    .option('--json', 'Emit JSON result to stdout')
    .action(async (flags: { config: string; refresh?: boolean; json?: boolean }) => {
      const ws = workspace();
      const cfg = loadWorkspaceReviewConfigOrExit(ws, flags.config);

      if (!cfg.references.enabled || cfg.references.sources.length === 0) {
        const empty = await loadReferences({ config: cfg.references, workspaceDir: ws });
        if (flags.json) {
          out(JSON.stringify(empty, null, 2));
        } else {
          status(
            'Reference documentation is not enabled or has no sources configured in .vor.yml (`references.enabled: true`).',
          );
        }
        return;
      }

      const octokit = optionalGithubOctokit();
      const corpus = await loadReferences({
        config: cfg.references,
        workspaceDir: ws,
        ...(octokit ? { octokit } : {}),
        forceRefresh: Boolean(flags.refresh),
      });

      for (const w of corpus.warnings) {
        status(color('yellow', `Warning: ${w}`));
      }

      if (flags.json) {
        out(JSON.stringify(corpus, null, 2));
      } else {
        out(renderRefsSync(corpus));
      }
    });

  refs
    .command('status')
    .description('Show reference cache directory and cached entries')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--json', 'Emit JSON result to stdout')
    .action((flags: { config: string; json?: boolean }) => {
      const ws = workspace();
      const cfg = loadWorkspaceReviewConfigOrExit(ws, flags.config);
      const cacheDir = resolveReferenceCacheDir(cfg.references.cache.dir, ws);
      const entries = new DiskReferenceCache(cacheDir).list();
      const nowMs = Date.now();

      if (flags.json) {
        out(
          JSON.stringify(
            {
              enabled: cfg.references.enabled,
              configured_sources: cfg.references.sources.length,
              cache_dir: cacheDir,
              entries: entries.map((e) => {
                const ageSeconds = Math.max(
                  0,
                  Math.round((nowMs - Date.parse(e.fetched_at)) / 1000),
                );
                return {
                  ...e,
                  age_seconds: ageSeconds,
                  fresh: ageSeconds < e.ttl_seconds,
                };
              }),
            },
            null,
            2,
          ),
        );
      } else {
        out(
          renderRefsStatus({
            enabled: cfg.references.enabled,
            configured_sources: cfg.references.sources.length,
            cache_dir: cacheDir,
            entries,
            nowMs,
          }),
        );
      }
    });

  refs
    .command('show <id>')
    .description('Print the normalized content of a configured reference document')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .action(async (id: string, flags: { config: string }) => {
      const ws = workspace();
      const cfg = loadWorkspaceReviewConfigOrExit(ws, flags.config);
      const octokit = optionalGithubOctokit();
      const corpus = await loadReferences({
        config: cfg.references,
        workspaceDir: ws,
        ...(octokit ? { octokit } : {}),
      });

      const doc = corpus.docs.find((d) => d.id === id);
      if (!doc) {
        const available = corpus.docs.map((d) => d.id).join(', ') || '(none)';
        status(color('red', `Reference doc '${id}' not found. Available: ${available}`));
        process.exit(1);
      }
      out(doc.content);
    });

  refs
    .command('clear')
    .description('Clear cached reference documentation entries on disk')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--id <id>', 'Remove only the cached entry matching this document ID or key')
    .action((flags: { config: string; id?: string }) => {
      const ws = workspace();
      const cfg = loadWorkspaceReviewConfigOrExit(ws, flags.config);
      const cacheDir = resolveReferenceCacheDir(cfg.references.cache.dir, ws);
      const removed = new DiskReferenceCache(cacheDir).clear(flags.id);
      status(
        color(
          'blue',
          `Removed ${removed} cached reference entr${removed === 1 ? 'y' : 'ies'} from ${cacheDir}.`,
        ),
      );
    });
}
