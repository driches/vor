# Vor knowledge bundle

- [overview](overview.md) — What Vor is: an AI PR-review GitHub Action (Claude or OpenAI) with parallel deterministic security and architecture scanning, cached team standards, and local CLI/MCP surfaces.
- [architecture](architecture.md) — The orchestrator-owned review loop with nine base tools, three conditional tools (`describe_image_at_ref`, `worker_check_usage_claim`, `read_reference_doc`), architecture invariants, and the repo/module layout.
- [scanners](scanners.md) — Deterministic security scanners, opt-in and reserved slots, the independent architecture scanner, the inline finding pipeline, and the binary-summary exception.
- [standards-and-references](standards-and-references.md) — Configurable software architecture enforcement (`hexagonal`, `ddd`, `clean`, `layered`, `modular-monolith`, `custom`, whole-repo `vor arch`) and two-layer cached reference documentation reading (`vor refs`, `read_reference_doc`).
- [tech-stack](tech-stack.md) — TypeScript/ESM/Node 20 stack, LLM/GitHub/MCP/Zod 4 dependencies, optional OCR, and the Svelte and Astro subprojects.
- [conventions](conventions.md) — AGENTS.md as source of truth, the non-negotiables, the four-check mergeability bar, and the golden-eval/local-review workflows.
