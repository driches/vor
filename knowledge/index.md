# Vor knowledge bundle

- [overview](overview.md) — What Vor is: AI PR review for GitHub Actions and Bitbucket Pipelines (Claude or OpenAI) with parallel vulnerability scanning, plus how it's used and distributed.
- [architecture](architecture.md) — The orchestrator-owned, platform-adapted review loop with nine base tools, conditional image inspection, and Anthropic-only worker verification, plus architecture invariants and the repo/module layout.
- [scanners](scanners.md) — The six default deterministic scanners, opt-in and reserved slots, the inline finding pipeline, and the binary-summary exception.
- [tech-stack](tech-stack.md) — TypeScript/ESM/Node 20 stack, LLM/GitHub/Bitbucket/MCP integrations, optional OCR, and the Svelte and Astro subprojects.
- [conventions](conventions.md) — AGENTS.md as source of truth, the non-negotiables, the four-check mergeability bar, and the golden-eval/local-review workflows.
- [maintenance log](log.md) — Dated changes to the synthesized knowledge bundle.
