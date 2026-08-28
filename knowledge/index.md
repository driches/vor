# Vor knowledge bundle

- [overview](overview.md) — What Vor is: an AI PR-review GitHub Action (Claude or OpenAI) with parallel vulnerability scanning, plus how it's used and distributed.
- [architecture](architecture.md) — The orchestrator-owned 9-tool review loop, architecture invariants, and the repo/module layout including dashboard, site, and scripts.
- [scanners](scanners.md) — The deterministic dependency-cve (OSV.dev) and secrets scanners and the shared severity/cap finding pipeline.
- [tech-stack](tech-stack.md) — TypeScript/ESM/Node 20 stack, LLM/GitHub/MCP dependencies, optional OCR, and the Svelte and Astro subprojects.
- [conventions](conventions.md) — AGENTS.md as source of truth, the non-negotiables, the four-check mergeability bar, and the golden-eval/local-review workflows.
