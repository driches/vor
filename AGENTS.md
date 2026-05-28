# AGENTS.md

**Canonical guidelines for AI agents (and humans) contributing to `driches/vor`.**

If you are an AI assistant — Claude, Copilot, Cursor, anything — read this file before touching the codebase. `CLAUDE.md` and similar tool-specific files point here.

This is an open-source project. Sloppy contributions waste maintainer time and degrade the codebase. The bar is set here in writing so there's no ambiguity about what will and won't be merged.

---

## 0. Hard rules — read first, no exceptions

These produce automatic PR rejection:

1. **No agentic fluff in code or PR descriptions.** No "Let me analyze the codebase...", no "I'll think through this step by step", no "Here's my plan:", no celebration emoji, no `console.log("✨ Success!")`, no "I've successfully implemented...". The diff is the work. Describe what changed and why. That's it.
2. **No celebration / decorative emoji anywhere** — not in code, not in comments, not in commit messages, not in CHANGELOG entries, not in PR descriptions, not in tests. Functional Unicode (—, ✓ in markdown tables for true/false) is fine. Decorative emoji (🚀 ✨ 🎉 ✅ ❌ used to be cute) is not.
3. **No claims of "verified" / "tested" / "passing" without evidence.** If you write "all tests pass," it's because you just ran `npm test` and saw the green. If you didn't run it, don't claim it. Same for `typecheck`, `build`, `verify-dist`.
4. **No `dist/index.js` changes without a corresponding `src/` change.** `dist/` is a build artifact. Hand-edits to it will be reverted and you'll be asked to regenerate via `npm run build`.
5. **No imports from `src/eval/*` into `src/!(eval)/*`.** [`scripts/verify-dist.ts`](scripts/verify-dist.ts) enforces this — the eval harness is local-only and must never ship in the action bundle.
6. **No `console.log` in production paths.** Use `logger.info / debug / warn / notice` from [`src/util/logger.ts`](src/util/logger.ts). `console.log` from `dist/` shows up unmasked in consumer CI logs, including potentially anything we passed through.
7. **No swallowed exceptions without an explicit reason in a comment.** `catch {}` with no body is a code smell. If you genuinely want to ignore an error, write `catch { /* <why> */ }`.
8. **No new dependencies without justification.** This package ships as a bundled GitHub Action. Every dep is in the bundle. Adding `lodash` to do something `Array.prototype` already does will be rejected.

---

## 1. Code style — what we keep, what we reject

### Comments

Comments explain **why**, not what. The code already says what.

**Reject:**
```ts
// Loop through the files
for (const file of files) {
  // Get the patch
  const patch = file.patch;
  // Check if it's null
  if (patch === null) {
    // Skip this file
    continue;
  }
}
```

**Accept:**
```ts
for (const file of files) {
  // GitHub returns `patch: null` for binary files and for renames with no
  // content change. The diff-anchored validator treats anchorless files as
  // not-reviewable rather than failing the whole run.
  if (file.patch == null) continue;
}
```

When you fix something a reviewer flagged, cite the review:

```ts
// `pattern-not-inside` only matched const-declared loops, so a let-declared
// `for...of` with `await Promise.all(...)` was a false-positive.
// addressing #42 (review).
```

This makes the codebase self-documenting about *why* a non-obvious decision was made. Future readers (human or agent) can trace the history without `git blame`-ing every line.

### TypeScript

- `strict: true` is on. Don't widen types to dodge a complaint — fix the underlying issue.
- `as unknown as Foo` requires a comment explaining why the type system can't see what you can. Most of the time the answer is "I should be checking this at runtime instead."
- `Record<string, unknown>` over `any`. `any` is rejected on review.
- Prefer narrow function input shapes (`{ owner: string; repo: string }`) over passing a god-object.

### Error handling

- Throw `Error` subclasses from [`src/util/errors.ts`](src/util/errors.ts) when the call site needs to discriminate. Plain `throw new Error(...)` is fine when the error is terminal.
- Don't catch-and-rethrow without adding information.
- Don't catch-and-log; either handle it or let it propagate.

### Logging

Use the structured logger. Levels:

| Level | When |
|---|---|
| `debug` | Internal state useful when triaging a problem report. Off by default in CI. |
| `info` | Progress markers an operator scanning the log expects to see (`Loaded PR…`, `Scanners finished…`). |
| `notice` | Something unusual but not wrong — `skipped_draft`, fork-PR with no key, etc. |
| `warn` | Something fell back to a default or partial result. The run continued. |
| `error` | The run is about to fail. |

Don't log secrets. The logger registers and masks `anthropic_api_key`, `openai_api_key`, and `github_token` automatically — but if you're adding a new secret-bearing input, call `registerSecret` from [`src/util/secrets.ts`](src/util/secrets.ts) at the entry point.

---

## 2. Architecture you must respect

### The orchestrator owns the flow

[`src/orchestrator.ts:runOrchestrator`](src/orchestrator.ts) is the single entry point. It:

1. Fetches PR context via Octokit
2. Loads `.vor.yml` from PR HEAD (with workspace fallback)
3. Runs scanners + the LLM agent (parallel by default, sequential when the experimental flag is on)
4. Aggregates, filters, dedups, posts

Don't add side-effects outside the orchestrator. If a new feature needs to run before/after the agent, wire it into the orchestrator — don't bolt on a top-level `if` in `src/index.ts`.

### Scanners are deterministic, the agent is not

| Layer | Output | When to add to it |
|---|---|---|
| **Scanners** (`src/scanners/`) | Pattern-matched findings. Fast, cheap, deterministic. | When the bug shape is a regex, AST pattern, or external check (CVE, lint rule). |
| **LLM agent** (`src/agent/`) | Semantic / contextual findings. Slow, costly, judgment-laden. | When the bug requires understanding intent (race conditions, doc-vs-code drift, "is this batchable?"). |

If a scanner can catch it, **don't** ask the agent to. Scanner findings are free. Agent turns are not.

### Tools are the agent's only side channel

Every action the agent takes goes through a registered tool in `src/tools/`. Tool handlers are responsible for validating inputs against the PR diff before they take effect — see [`src/tools/post-inline-comment.ts`](src/tools/post-inline-comment.ts) for the canonical example. **Validators run BEFORE the agent's request hits any external system.** Bypassing validation is a security issue, not a stylistic one.

### `OrchestratorOutput.kept_comments` is the eval contract

The eval harnesses ([`scripts/eval/synthetic-real.ts`](scripts/eval/synthetic-real.ts), [`captured-real.ts`](scripts/eval/captured-real.ts)) read this field to score findings against ground truth. Don't break the shape. If you need new fields, add them; don't remove or rename existing ones.

---

## 3. What "done" means

A PR is mergeable when ALL of these are true. Run them locally before pushing, and again after any change in the PR review cycle:

```sh
npm run lint              # eslint, zero errors
npx tsc --noEmit          # zero errors
npm test -- --run         # 1000+ tests, all passing
npm run verify-dist       # rebuilds + checks dist/ in sync with src/ AND no eval/* leakage
```

`verify-dist` rebuilds internally and fails if the committed `dist/index.js` is stale, so you don't need a separate `npm run build` step before it. If `verify-dist` fails, run `npm run build` and commit the regenerated bundle.

If you changed user-facing behavior, ALSO:

- Update `CHANGELOG.md` under `## [Unreleased]`. Cite measurements if you have them. "−15% cost on synthetic eval" is more useful than "improved performance."

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same four commands in the same order. If CI fails on something that passes locally, it's a real problem — investigate, don't just re-trigger.

### The "tests pass" trap

If your change touches LLM-adjacent code (prompts, tools, agent loop, scanners), running unit tests is the floor, not the ceiling. The unit tests verify mechanics; they can't verify "does the agent still find security bugs."

### The "I tested it locally" trap

`npm run local-review -- --base origin/main --head HEAD` runs the full pipeline (scanners + agent) against your working copy in <2 minutes, no GitHub round-trip required. Use it before claiming a change works on real PRs.

---

## 4. PR conventions

### Branch names

`<type>/<short-kebab>`. Same `<type>` as Conventional Commits:
- `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, `perf/`, `build/`

### Commits

[Conventional Commits](https://www.conventionalcommits.org/). Subject under 70 chars. Body explains why.

**Good:**
```
fix(github): pass numeric status codes to plugin-retry doNotRetry

`@octokit/plugin-retry` compares `error.status` (a number) against
`doNotRetry` entries via `Array.prototype.includes`, which uses
strict equality. We were passing strings, so 4xx retries never
short-circuited. Switching to numbers fixes the comparison.
```

**Reject:**
```
Update file

Made some improvements to the code.
```

### PR descriptions

Use [the template](.github/PULL_REQUEST_TEMPLATE.md). Specifically:

- **Summary**: 1-3 sentences explaining the change and the motivation
- **Linked issue**: closes #N, or "n/a — drive-by"
- **Test plan**: which commands you ran, what you observed. If you ran the eval harnesses, include the cost + recall numbers.
- **Notes for reviewers**: anything subtle, intentional, or context the diff doesn't carry

If your PR description reads like a marketing post, rewrite it. Reviewers want to know what you did, not how excited you are about it.

### Dogfooding

Self-review on this repo is **manual** ([`.github/workflows/self-review.yml`](.github/workflows/self-review.yml) is `workflow_dispatch` only — the auto-trigger on `pull_request` was disabled to prevent feedback loops on prompt-iteration PRs). A maintainer dispatches a review on PRs that touch the prompt, tools, or scanners — and on anything else where the dogfood signal is worth the credits.

When a self-review does fire on your PR:

- **Read it.** Even if the finding looks wrong, treat it as a signal the code is misleading enough to confuse an agent.
- **Reply in the thread.** Either fix what's flagged, or explain why it's wrong. Don't ignore it.
- **If the finding is a false positive**, that's also useful — open a [`review-quality`](https://github.com/driches/vor/issues/new?template=review_quality.yml) issue so the prompt / scanner gets calibrated.

To run a self-review yourself, ask a maintainer to dispatch it:

```sh
gh workflow run self-review.yml \
  --ref <PR-head-branch> \
  -f pr_number=<your-PR> \
  -R driches/vor
```

`--ref` is required when the dogfood needs to run **the PR's code**, not main's. The workflow does `actions/checkout@v5` with no explicit ref and then `uses: ./`, so the action that runs is whatever ref was dispatched — without `--ref`, GitHub defaults to the default branch (main) and the PR's prompt / tool / scanner changes never get exercised. For PRs that only touch docs or tests, dispatching against `main` is fine because no executable code changed.

The job posts a review on the PR within a few minutes.

If a self-review costs more than ~$0.50 on a PR under 500 LOC, that's a smell — investigate before merging.

---

## 5. Receiving review feedback

Reviews on this repo come from a few sources: any auto-reviewer bot configured on the repo, human reviewers, and our own manually-dispatched self-review (§4). Whatever the source, the expected response pattern is the same:

1. **Read the comment in full** before responding. Don't pattern-match on the first sentence.
2. **Decide if you agree.** If you don't, explain why in the thread — quote the line, cite where the reviewer's premise is wrong. Reviewers can be wrong. Disagreement with evidence is welcome; capitulation isn't.
3. **If you fix it**, the commit message should reference the comment ID (e.g. `addressing #42 (review)`). The fix-commit's body should explain what changed, not just "addressed review."
4. **Reply on the thread** with a one-liner: what you changed (or why you didn't). Then resolve the thread.

We track review comment IDs in commit messages so the codebase is self-documenting about which decisions came from which review.

---

## 6. Don't do these things

### Agentic fluff (auto-reject)

| Reject | Why |
|---|---|
| `// Let me think through this...` | Comments are for the reader, not the writer |
| `// Successfully refactored to use Map` | The reader can see it's a Map. They want to know **why**. |
| `// TODO: figure out a better way` | File an issue or remove the code. TODOs rot. |
| PR description starting with "I've completed the implementation" | We can see you opened a PR. |
| Commit message "feat: comprehensive improvements to error handling" | What error handling? In which file? |
| `if (true) { … }` wrappers around real logic ("just in case") | Delete them |
| Defensive `?? undefined` on values the type system already guarantees | The compiler doesn't lie. Don't pad against imaginary failure modes. |

### Premature abstraction

Don't add a "configurable" interface for one caller. Wait for two. When the second caller arrives, *then* the abstraction's shape becomes obvious.

### "I'll just bump this dep"

Dep bumps belong in their own PR with a CHANGELOG note if user-facing. Don't smuggle major version jumps into a feature PR — the blast radius hides.

### Output-token padding

The action ships findings to users. Don't pad why-it-matters paragraphs with throat-clearing. Get to the point in the first sentence; the second sentence adds the *why this matters specifically here.* The third sentence usually doesn't exist.

---

## 7. When the self-review runs, it checks you

Self-review is manually dispatched (see §4 — Dogfooding), not on every PR. When a maintainer does dispatch it against your branch (or you ask one to), the same action this repo *produces* will run against your code. It catches:

- TypeScript errors (`tsc` scanner)
- Lint violations (`eslint`, `ruff`, `dart analyze`, `actionlint`, depending on file type)
- Unused exports (`knip`)
- Known Semgrep patterns including the bundled rule pack at [.vor/semgrep-rules/](.vor/semgrep-rules/)
- Dependency CVEs (OSV-backed)
- Coverage gaps (opt-in)
- Plus semantic findings the agent decides are worth surfacing

If a dispatched self-review flags something obvious you "didn't see" while writing the code, that's a signal the code is doing something non-obvious. Add a comment explaining why, or restructure the code so it's no longer surprising.

For PRs that touch the prompt, tools, or scanners, get a self-review dispatched against the PR branch (`--ref <PR-head-branch>`) before merge — the local `npm run lint / tsc / test / verify-dist` quartet can't verify "does the agent still find security bugs," and CI doesn't run a full behavioral eval.

---

## 8. Releasing (maintainer-only)

1. Bump `version` in `package.json` and `package-lock.json`
2. Move `## [Unreleased]` content to a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`
3. `npm run build && npm run verify-dist` — must be clean
4. Open release PR, merge
5. From main: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
6. The [`release.yml` workflow](.github/workflows/release.yml) handles: full test + build + verify-dist, GitHub release with auto notes, moves the `v0` major tag to point at the new release

Pre-1.0, breaking changes can land in minor versions; just call them out in the CHANGELOG.

---

## 9. Getting help

- [GitHub Discussions](https://github.com/driches/vor/discussions) — questions, design feedback, "is this a bug?"
- [SUPPORT.md](SUPPORT.md) — routing for specific kinds of questions
- [SECURITY.md](SECURITY.md) — vulnerability disclosure (do NOT file public issues)

If you're stuck for more than 30 minutes on getting the dev environment running, open a Discussion. The setup steps in [CONTRIBUTING.md](CONTRIBUTING.md) should work on a fresh machine; if they don't, that's a bug worth filing.
