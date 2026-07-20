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

- **LLM providers**: `@anthropic-ai/sdk` (^0.39.0), `openai` (^6.39.0) — the dual-provider core of [the review loop](/architecture.md).
- **GitHub**: `@actions/core`, `@octokit/rest` with `@octokit/plugin-retry` and `@octokit/plugin-throttling`.
- **MCP**: `@modelcontextprotocol/sdk` (^1.29.0) — there is a `src/mcp` module.
- **Diff/parsing**: `parse-diff`, `semver`, `yaml`.
- **Schemas**: `zod` + `zod-to-json-schema` (likely how tool schemas are produced; unconfirmed).
- **CLI**: `commander`.

## Optional dependencies

- `tesseract.js` / `tesseract.js-core` (^7.0.0) — OCR; `assets/ocr/` and `src/ocr` exist, and `assets/ocr/` ships in the published package.

## Subprojects

- Dashboard: Svelte via `@sveltejs/vite-plugin-svelte`, built with Vite.
- Docs site: Astro (`site/astro.config.mjs`), separate package.json.

## Open questions

- Which OCR/vision features are user-facing (e.g. reviewing images in PRs?) — the digest only evidences the modules and deps.
