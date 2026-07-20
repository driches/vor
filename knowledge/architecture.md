---
type: Architecture
title: Review Loop and Repo Structure
description: An orchestrator-owned, provider-agnostic tool-use loop drives the model over 9 constrained custom tools with no built-in filesystem or shell access.
tags: [architecture, orchestrator, tool-use, agent]
timestamp: 2026-07-20T00:00:00Z
---

# Review Loop and Repo Structure

## The tool-use loop

A custom tool-use loop drives the model over a constrained set of 9 custom tools (read PR diff, read file at ref, grep the checkout, post inline comments, post summary) with **no built-in filesystem/shell access**. The single output tool, `post_inline_comment`, validates `(file_path, line)` against the actual diff before accepting — the agent cannot post on lines that don't exist. On rejection it gets a structured hint listing the real reviewable lines so it self-corrects.

## Architecture invariants (from AGENTS.md, via CLAUDE.md)

- The **orchestrator owns the flow** (`src/orchestrator.ts`).
- **Scanners are deterministic** — see [scanners](/scanners.md).
- **Tools validate before they take effect.**

## Source layout

`src/` modules (top-level per the digest): `orchestrator.ts`, `types.ts`, `index.ts`, plus directories `tools`, `llm`, `context`, `agent`, `mcp`, `scanners`, `github`, `output`, `config`, `cli`, `local`, `dashboard`, `ocr`, `vision`, `util`, `eval`. Tests sit alongside source (`src/orchestrator.test.ts`) with fixtures in `tests/fixtures`.

## Sibling components

- `dashboard/` — a Svelte + Vite app (`svelte.config.js`, `vite.config.ts`), built via `npm run build:dashboard`.
- `site/` — an Astro-based documentation site (`astro.config.mjs`) with its own package.json.
- `scripts/` — build (`build.ts`), `verify-dist.ts`, `local-review.ts`, `smoke-openai.ts`, `test-blast-radius.ts`, `plant.ts`, and the `golden/` eval harness (see [conventions](/conventions.md)).
- `.vor/` — the repo dogfoods itself: `security-ignore.yml` and `semgrep-rules` live here.
- `dist/` is a committed build artifact; `verify-dist` checks it stays in sync with `src/`.

## Open questions

- Exact responsibilities of `src/mcp`, `src/vision`, `src/ocr` (OCR likely relates to the optional `tesseract.js` dependency and `assets/ocr/`), and `src/local` — a source-level ingest should confirm.
- The full list and schemas of the 9 tools.
- What `docs/strategy/` contains.
