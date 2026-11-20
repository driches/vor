# Reference documentation & standards caching

Vor can read team and organization reference documentation — ADRs, coding standards, API style guides, and security runbooks — and cache them across two layers so reviews stay fast and token-efficient.

## Quick start

Configure `references:` in `.vor.yml`:

```yaml
references:
  enabled: true
  sources:
    - docs/standards.md
    - "docs/adr/**/*.md"
    - https://example.com/engineering/api-guide.html
    - github:acme/engineering-standards/docs/ddd.md@main
    - id: runbook
      title: Production Incident Runbook
      path: docs/runbook.md
      mode: on_demand
```

## Supported sources

Each entry in `references.sources` can be a shorthand string or an object:

| Shorthand / Field | Example | Behavior |
|---|---|---|
| Repo file (`path`) | `docs/standards.md` | Reads file at PR HEAD (or local working tree). |
| Repo glob (`glob`) | `docs/adr/**/*.md` | Expands matching repo files in sorted order. |
| Remote URL (`url`) | `https://example.com/guide.html` | Fetches HTTP/HTTPS text or markdown; strips HTML chrome (`script`/`style`/`nav`/`footer`) into clean markdown text. Cloud metadata hosts are blocked. |
| Cross-repo GitHub (`github`) | `github:org/repo/docs/std.md@main` | Reads files or globs from another GitHub repo (including private org repos using `github_token` / `GITHUB_TOKEN`). |

Object fields: `id`, `title`, `path`, `glob`, `url`, `github`, `mode` (`auto` | `inline` | `on_demand`), and `ttl_seconds` (per-source TTL override).

## Hybrid inline + on-demand delivery

Large reference libraries do not need to flood every turn's prompt:

- `inline` / `auto` documents are packed into the system prompt prefix up to `max_inline_bytes` (default `80000` bytes).
- Documents explicitly marked `mode: on_demand`, or `auto` documents that exceed `max_inline_bytes`, remain indexed in a compact catalog table (ID, title, size, headings) and are read on demand by the agent via `read_reference_doc({ id, start_line, end_line })` or searched with `read_reference_doc({ query })`.
- Individual documents are capped at `max_doc_bytes` (default `100000`) and total documents at `max_docs` (default `100`).

## Two-layer caching

### 1. Persistent disk & CI content cache

Normalized documents and metadata (SHA-256 content hash, `ETag`, `Last-Modified`, source fingerprint, headings, and timestamp) are stored in `references.cache.dir` (defaults to `$VOR_CACHE_DIR/references` or `~/.vor/cache/references`).

- **TTL & conditional revalidation:** Remote HTTP/HTTPS and cross-repo GitHub entries within `ttl_seconds` (default `86400` / 24h) hit disk with zero network calls. Expired URLs send `If-None-Match` / `If-Modified-Since` headers and refresh via `304 Not Modified` without re-downloading.
- **Local file fingerprinting:** Repo files track `mtime` + size (or SHA-256 content hash) so edits invalidate immediately while unchanged docs skip re-normalization.
- **Offline resilience:** When `stale_on_error: true` (default), transient HTTP/GitHub failures serve the last cached copy with a warning instead of dropping standards or failing the review.

Persist the cache across GitHub Actions runs with `actions/cache`:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.vor/cache/references
    key: vor-refs-${{ github.repository }}-${{ hashFiles('.vor.yml') }}
    restore-keys: |
      vor-refs-${{ github.repository }}-
```

### 2. LLM prompt caching

The rendered reference section sits in the static system-prompt prefix and never embeds timestamps or cache hit/miss counters, keeping the prefix byte-identical across turns and PRs:

- **Anthropic (`prompt_cache.anthropic_ttl`):** Uses `{ type: 'ephemeral' }` (`5m` default) or `{ type: 'ephemeral', ttl: '1h' }` when `anthropic_ttl: 1h` is set so multi-PR bursts reuse the cached system prefix.
- **OpenAI (`prompt_cache.auto_openai_cache_key`):** When enabled and `providers.openai.prompt_cache_key` is unset, automatically derives `vor:<owner>/<repo>:refs-<digest>` from the corpus SHA-256 digest for optimal cache routing. Pair with `providers.openai.prompt_cache_retention: 24h` on supported models.

## CLI & MCP tools

Inspect, pre-warm, and manage the reference cache locally or in CI:

```sh
vor refs sync                 # load sources and populate disk cache
vor refs sync --refresh       # bypass fresh TTLs and revalidate all sources
vor refs status               # inspect cached entries, age, TTL, and ETags
vor refs show <id>            # print normalized content for one doc
vor refs clear [--id <id>]    # clear cached entries
```

MCP server tools exposed by `vor mcp`:

- `list_references` — loads/caches configured sources and returns the catalog + cache stats
- `read_reference` — slices or searches cached reference documents by `id` or `query`
