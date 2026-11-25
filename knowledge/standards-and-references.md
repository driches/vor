---
type: Concept
title: Architecture Standards and Reference Caching
description: Hybrid software architecture enforcement (deterministic import/boundary scanner plus LLM principles, CLI, and MCP) and two-layer cached reference documentation reading for standards and runbooks.
tags: [architecture-standards, references, caching, presets, cli, mcp]
timestamp: 2026-11-25T00:00:00Z
---

# Architecture Standards and Reference Caching

Vor pairs deterministic PR/whole-repo architecture boundary checks with cached reference-doc ingestion so domain standards, ADRs, and architecture rules apply consistently at low token cost. Both subsystems live independently of `security.enabled` in [`src/config/schema.ts`](../src/config/schema.ts).

## Software architecture standards

Configuration lives under `architecture:` in `.vor.yml` or an external file referenced via `architecture.file` (for example `.vor/architecture.yml`; auto-discovered by [`resolveWorkspaceArchitectureConfig`](../src/architecture/loader.ts) when local CLI/MCP runs have no `architecture:` block in `.vor.yml`):

- **Built-in presets and customization**: [`resolveArchitectureSpec`](../src/architecture/presets.ts) provides `hexagonal`, `ddd`, `clean`, `layered`, `modular-monolith`, and `custom` presets, supports `root` directory scoping, merges partial `layers` overrides without dropping preset rules, and supports custom `rules`, natural-language `principles`, and `ignore_tests` / `exclude` filters.
- **Bounded contexts and module isolation**: `contexts` enforces `pattern` matching, `public_api` barrel globs, `shared` kernel exemptions, and `allow_dependencies`. [`evaluateFileArchitecture`](../src/architecture/evaluator.ts) checks `contextRoot` before the leaf `context` name in `allow_dependencies` for most-specific-first precedence across multi-root repos, while cross-root imports sharing a leaf module name still trigger `arch:context-boundary` checks.
- **Multi-language import extraction and resolution**: [`imports.ts`](../src/architecture/imports.ts) performs comment-aware extraction and workspace path resolution with zero new npm dependencies across TypeScript/JavaScript (`tsconfig.json` `baseUrl`/`paths`, ESM `.js` -> `.ts`), Python, Go (`go.mod` and `go.work` `use`/`replace` directives hydrated from PR HEAD in PR scans), Dart (`pubspec.yaml`), Rust, Java/Kotlin, and C#.
- **Hybrid enforcement**: When `deterministic_enforcement` is true, [`createArchitectureScanner`](../src/scanners/architecture.ts) evaluates PR-added lines and attaches findings tagged `_via architecture scan_` (summarized under `**Architecture:**` when any exist), consulting `.vor/security-ignore.yml` for file/rule suppressions. When `llm_enforcement` is true, [`renderArchitecturePrompt`](../src/architecture/prompt.ts) injects the resolved architecture summary and `principles` into the review agent's system prompt.
- **Whole-repo CLI & MCP**: [`arch.ts`](../src/cli/commands/arch.ts) exposes `vor arch check` (`--fail-on`, `--preset`, `--root`, `--json`, `--update-baseline` for `.vor/arch-baseline.json`), `vor arch init`, `vor arch presets`, and `vor arch explain <file>`, backed by [`runRepoArchitectureCheck`](../src/architecture/repo-scan.ts); `vor mcp` exposes `check_architecture` ([`src/mcp/tools.ts`](../src/mcp/tools.ts)). See [architecture](architecture.md) and [scanners](scanners.md).

## Reference documentation & two-layer caching

Configuration lives under `references:` in `.vor.yml` and loads via [`loadReferences`](../src/references/loader.ts):

- **Sources & sanitization**: Accepts repository files/globs (read at PR HEAD via `FileReader` + `git.getTree`, skipping confirmed 404 absences rather than falling back to stale checkout files on disk), remote HTTP/HTTPS URLs (`text.ts` converts HTML to clean markdown while stripping `script`/`style`/`nav`/`footer`/`noscript`; public-DNS / private-IP checks block SSRF and cloud metadata hosts), and cross-repo `github:owner/repo/path@ref` sources (`githubOctokit` can be `null` in unauthenticated local mode to disable remote `github:` fetches without disabling local `octokit` repo glob expansion).
- **Layer 1 — Persistent disk cache**: [`DiskReferenceCache`](../src/references/cache.ts) stores content-addressed entries (default `~/.vor/cache/references` or `$VOR_CACHE_DIR`) validated by SHA-256 checksum, `ttl_seconds`, HTTP `ETag` / `If-Modified-Since` `304` revalidation, per-workspace ref/fingerprint keys (invalidating local mutable `WORKTREE`/`HEAD` refs by mtime/size), `stale_on_error` offline fallback, and symlink protection (`lstatSync` + `O_NOFOLLOW` on POSIX).
- **Layer 2 — Prompt cache & hybrid delivery**: [`renderReferencesPrompt`](../src/references/prompt.ts) writes `inline` / fitting `auto` docs up to `max_inline_bytes` into a byte-deterministic system-prompt prefix (free of volatile hit/miss timestamps). Overflow or `mode: on_demand` docs stay in a compact catalog read/searched on demand through [`read_reference_doc`](../src/tools/read-reference-doc.ts) and [`search.ts`](../src/references/search.ts). [`anthropic-provider.ts`](../src/llm/anthropic-provider.ts) supports `prompt_cache.anthropic_ttl: 1h` (billed at 2x base input in [`pricing.ts`](../src/util/pricing.ts), with `5m` TTL on conversation message breakpoints), and the orchestrator derives `vor:<owner>/<repo>:refs-<digest>` as a low-cardinality OpenAI `prompt_cache_key` when `auto_openai_cache_key` is enabled.
- **CLI & MCP**: `vor refs sync|status|show|clear` ([`refs.ts`](../src/cli/commands/refs.ts)) and MCP tools `list_references` / `read_reference` ([`src/mcp/tools.ts`](../src/mcp/tools.ts)) manage and inspect cached standards offline.
