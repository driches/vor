---
type: Architecture
title: Review Loop and Repo Structure
description: An orchestrator-owned, provider-agnostic loop exposes nine constrained base tools plus conditional image-inspection, Anthropic worker-verification, and on-demand reference-doc tools, with no built-in filesystem or shell access.
tags: [architecture, orchestrator, tool-use, agent]
timestamp: 2026-11-25T00:00:00Z
---

# Review Loop and Repo Structure

## The tool-use loop

A custom tool-use loop gives the model nine base tools with **no built-in filesystem/shell access**: `get_pr_metadata`, `list_changed_files`, `get_pr_diff`, `read_file_at_ref`, `grep_repo_at_ref`, `read_repo_context_file`, `post_inline_comment`, `post_summary`, and `skip_file`.

Three configuration-gated tools can expand the active set up to twelve:

- `describe_image_at_ref` is added when `image_understanding.enabled` is true. It returns OCR text and, when supported by the provider, a visual description of an image at HEAD or BASE.
- `worker_check_usage_claim` is added only when experimental worker delegation is enabled and the resolved provider is Anthropic. OpenAI runs disable worker delegation, so this tool is not registered for them. It delegates focused unused-symbol, single-caller, or pattern-verification claims to a cheaper worker and returns a structured verdict.
- `read_reference_doc` is added when `references.enabled` is true and at least one configured reference document is loaded into the corpus (see [standards-and-references](standards-and-references.md)). It slices or searches on-demand and overflow reference docs by id or query.

Before accepting an inline finding, `post_inline_comment` validates `(file_path, line)` against the actual diff — the agent cannot comment on lines that do not exist. On rejection it gets a structured hint listing the real reviewable lines so it can self-correct.

## Architecture invariants (from AGENTS.md, via CLAUDE.md)

- The **orchestrator owns the flow** (`src/orchestrator.ts`).
- **Scanners are deterministic** — see [scanners](scanners.md).
- **Tools validate before they take effect.**

## Source layout

`src/` modules (top-level per the digest): `orchestrator.ts`, `types.ts`, `index.ts`, plus directories `agent`, `architecture`, `cli`, `config`, `context`, `dashboard`, `eval`, `github`, `llm`, `local`, `mcp`, `ocr`, `output`, `references`, `scanners`, `tools`, `util`, `vision`. Tests sit alongside source (`src/orchestrator.test.ts`) with fixtures in `tests/fixtures`.

Notable support modules:

- `src/architecture/` loads and resolves architecture specs (`.vor.yml` or `.vor/architecture.yml`), extracts multi-language imports, evaluates layer/context/custom rules, renders prompt guidance, and runs whole-repo boundary scans.
- `src/references/` loads repo, HTTP/HTTPS URL, and cross-repo `github:` docs with two-layer caching (content-addressed disk/ETag store plus deterministic system-prompt packing) and full-text snippet search.
- `src/local/` builds git-backed PR context, runs the production orchestrator against a range or working tree, and persists local run history for the CLI, dashboard, and MCP server.
- `src/mcp/` exposes local review, run history, configuration, architecture checks (`check_architecture`), and cached references (`list_references`, `read_reference`) over a stdio MCP server.
- `src/ocr/` provides offline Tesseract text extraction for the image scanner and image-reading agent tool.
- `src/vision/` provides the optional model-backed visual description used by `describe_image_at_ref`.

## Sibling components

- `dashboard/` — a Svelte + Vite app (`svelte.config.js`, `vite.config.ts`), built via `npm run build:dashboard`.
- `site/` — an Astro-based documentation site (`astro.config.mjs`) with its own package.json.
- `scripts/` — build (`build.ts`), `verify-dist.ts`, `local-review.ts`, `smoke-openai.ts`, `test-blast-radius.ts`, `plant.ts`, and the `golden/` eval harness (see [conventions](conventions.md)).
- `.vor/` & `.vor.yml` — the repo dogfoods itself: `.vor.yml` enables `architecture` (pointing at `.vor/architecture.yml`) and `references` (indexing `knowledge/`), alongside `security-ignore.yml` and `semgrep-rules`.
- `dist/` is a committed build artifact; `verify-dist` checks it stays in sync with `src/`.
- `docs/strategy/differentiation.md` is the maintainer-facing positioning and competitive-strategy memo; it is not synchronized to the public docs site.
