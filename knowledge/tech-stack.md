---
type: Dependency
title: Tech Stack and Key Dependencies
description: TypeScript ESM Node >=20 project using the Anthropic and OpenAI SDKs, Octokit, zod, and vitest, with Svelte (dashboard) and Astro (site) subprojects.
tags: [typescript, node, dependencies, tooling]
timestamp: 2026-07-20T00:00:00Z
---

# Tech Stack and Key Dependencies

TypeScript, ESM (`"type": "module"`), Node `>=20` (`.nvmrc` present). Built with a custom `tsx scripts/build.ts`; tested with vitest (`vitest.config.ts`); linted with ESLint (flat config `eslint.config.mjs`) and formatted with Prettier.

## Runtime dependencies

- **LLM providers**: `@anthropic-ai/sdk` (^0.39.0), `openai` (^6.39.0) — the dual-provider core of [the review loop](architecture.md).
- **GitHub**: `@actions/core`, `@octokit/rest` with `@octokit/plugin-retry` and `@octokit/plugin-throttling`.
- **MCP**: `@modelcontextprotocol/sdk` (^1.29.0) — the stdio server exposes local review, run-history, and configuration tools.
- **Diff/parsing**: `parse-diff`, `semver`, `yaml`.
- **Schemas**: `zod` validates tool and configuration inputs; `zod-to-json-schema` converts agent-tool schemas for model providers.
- **CLI**: `commander`.

## Optional dependencies

- `tesseract.js` / `tesseract.js-core` (^7.0.0) — offline OCR for the opt-in `image-ocr` scanner and conditional `describe_image_at_ref` agent tool. Vendored runtime assets under `assets/ocr/` ship in the package.

## Subprojects

- Dashboard: Svelte via `@sveltejs/vite-plugin-svelte`, built with Vite.
- Docs site: Astro (`site/astro.config.mjs`), separate package.json.
