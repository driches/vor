---
type: Dependency
title: Tech Stack and Key Dependencies
description: TypeScript ESM Node >=20 project using the Anthropic and OpenAI SDKs, Octokit, zod 4, and vitest, with Svelte (dashboard) and Astro (site) subprojects.
tags: [typescript, node, dependencies, tooling]
timestamp: 2026-11-25T00:00:00Z
---

# Tech Stack and Key Dependencies

TypeScript, ESM (`"type": "module"`), Node `>=20` (`.nvmrc` present). Built with custom `tsx scripts/build.ts` using `esbuild` (`0.28.2`); tested with vitest (`vitest.config.ts`); linted with ESLint (flat config `eslint.config.mjs`) and formatted with Prettier.

## Runtime dependencies

- **LLM providers**: `@anthropic-ai/sdk` (^0.39.0), `openai` (^6.49.0) — the dual-provider core of [the review loop](architecture.md).
- **GitHub**: `@actions/core` (3.0.1), `@octokit/rest` (^21.1.1) with `@octokit/plugin-retry` and `@octokit/plugin-throttling`.
- **MCP**: `@modelcontextprotocol/sdk` (^1.32.2) — the stdio server exposes local review, run-history, configuration, architecture check, and reference-doc tools.
- **Diff/parsing**: `parse-diff`, `semver`, `yaml`.
- **Schemas**: `zod` (^4.6.7) validates tool and configuration inputs and emits JSON Schemas via Zod 4's built-in JSON Schema conversion.
- **CLI**: `commander` (^12.1.0).

## Optional dependencies

- `tesseract.js` / `tesseract.js-core` (^7.0.0) — offline OCR for the opt-in `image-ocr` scanner and conditional `describe_image_at_ref` agent tool. Vendored runtime assets under `assets/ocr/` ship in the package.

## Subprojects

- Dashboard: Svelte (`^5.56.2`) via `@sveltejs/vite-plugin-svelte`, built with Vite (`vite build dashboard`).
- Docs site: Astro (`^7.2.9`) + Starlight (`^0.41.10`) in `site/` (`site/astro.config.mjs`), separate package.json (`engines.node >= 22.12.0`).
