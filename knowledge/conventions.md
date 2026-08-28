---
type: Convention
title: Contribution Conventions and Workflows
description: AGENTS.md is the single source of truth for contributor rules; a PR is mergeable only when lint, typecheck, tests, and verify-dist are all green locally.
tags: [conventions, workflow, ci, eval, agents-md]
timestamp: 2026-07-20T00:00:00Z
---

# Contribution Conventions and Workflows

## Single source of truth

Contribution guidelines for AI agents live in **AGENTS.md**. Tool-specific files (`CLAUDE.md`, `.cursorrules`, etc.) all defer to it; on conflict, AGENTS.md wins. AGENTS.md also covers code style, [architecture invariants](architecture.md), eval usage, PR/commit/dogfooding conventions, and auto-reject patterns.

## Non-negotiables (CLAUDE.md summary)

1. No agentic fluff in prose; no decorative emoji anywhere (code, commits, CHANGELOG, PRs).
2. No claims of "tested"/"passing" without having actually run it.
3. No `dist/index.js` edits without a corresponding `src/` change — dist is a build artifact.
4. No `console.log` in production paths — use `logger.info / debug / warn / notice` from `src/util/logger.ts`.
5. Comments should say *why*, not *what*.

## Definition of mergeable

All four must be green locally:

```sh
npm run lint
npx tsc --noEmit
npm test -- --run
npm run verify-dist   # rebuilds internally and checks dist/ is in sync
```

User-facing changes also need a `CHANGELOG.md` entry under `## [Unreleased]`.

## Eval and local workflows

npm scripts provide `golden:capture`, `golden:capture-batch`, `golden:discover`, `golden:eval`, and `golden:plant` (`scripts/golden/`, `scripts/plant.ts`), plus `local-review`. The OpenAI provider smoke test is invoked directly with `OPENAI_API_KEY=... npx tsx scripts/smoke-openai.ts`; it is not an npm script. `golden:eval` runs the selected model against captured cases in a separate private `GOLDEN_REPO_PATH`, compares normalized findings with stored Codex findings, and records matches, misses, turns, token use, and cost. It is an optional private-dataset harness that requires provider credentials, not a merge gate. For prompt, tool, or scanner changes, AGENTS.md instead requires a self-review dispatched against the PR branch before merge; `local-review` should be run before claiming a change works on real PRs.
