# CLAUDE.md

This project's contribution guidelines for AI agents are in **[AGENTS.md](AGENTS.md)** — read that first.

Tool-specific files (`CLAUDE.md`, `.cursorrules`, etc.) all defer to `AGENTS.md` so there's exactly one source of truth. If you find a conflict, `AGENTS.md` wins.

---

## The non-negotiables (full list in AGENTS.md §0)

Before you write a single line:

1. **No agentic fluff.** No "Let me think...", no "I'll analyze...", no celebration emoji, no "I've successfully implemented...". The diff is the work.
2. **No decorative emoji** — not in code, comments, commits, CHANGELOG, or PR descriptions.
3. **No claims of "tested" / "passing" without evidence.** If you say it passes, you ran it.
4. **No `dist/index.js` edits without a corresponding `src/` change.** It's a build artifact.
5. **No `console.log` in production paths.** Use `logger.info / debug / warn / notice` from [`src/util/logger.ts`](src/util/logger.ts).

A PR is mergeable when all four of these are green locally:

```sh
npm run lint
npx tsc --noEmit
npm test -- --run
npm run verify-dist     # rebuilds internally and checks dist/ is in sync
```

User-facing changes also need a `CHANGELOG.md` entry under `## [Unreleased]`.

---

## Read AGENTS.md before doing anything substantive

The short list above won't catch most of the ways a contribution can be off-pattern. AGENTS.md covers:

- Code style (comments, TypeScript discipline, error handling, logging)
- Architecture invariants (the orchestrator owns the flow; scanners are deterministic; tools validate before they take effect)
- What "done" means, including how to use the eval harnesses to verify behavior changes
- PR + commit + dogfooding conventions
- How to receive code review (including from Codex on this repo)
- The full list of patterns that auto-reject

If you're about to write a comment that says *what* the code does instead of *why*, stop and read AGENTS.md §1 first.
