# Contributing

Thanks for thinking about contributing. This is a small project — issues, PRs, and review-quality reports are all useful, and "I tried the action and here's what felt off" feedback in [Discussions](https://github.com/driches/code-review/discussions) is just as welcome as code.

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

> **Using an AI assistant to write the code?** Read **[AGENTS.md](AGENTS.md)** first. Same rules apply whether the keystrokes came from you or from Claude / Codex / Copilot — but the bar on "agentic fluff" (filler comments, decorative emoji, unverified claims of "tested and passing") is set explicitly there because that's where AI contributions most often go wrong. PRs that include any of those patterns get reverted.

## Getting started

### Development setup

```sh
nvm use            # node 20
npm install
npm run typecheck
npm test
npm run build      # bundles src/ → dist/index.js via esbuild
npm run verify-dist
```

If `verify-dist` fails, the committed `dist/` is out of sync with `src/`. Run `npm run build` and commit the regenerated bundle.

### Claiming an issue

Comment "I'll take this" on the issue before starting. The maintainer will assign it. If you don't open a PR within ~10 days, the assignment may be released so others can pick it up.

Good starting points:

- [`good first issue`](https://github.com/driches/code-review/labels/good%20first%20issue) — scoped, no deep context required
- [`help wanted`](https://github.com/driches/code-review/labels/help%20wanted) — larger, but with a clear shape

If you can't find an issue but have something in mind, open a Discussion first to check it's wanted before sinking time into it.

## Sending a PR

### Branch naming

`<type>/<short-description>` — e.g. `feat/exclude-paths-glob`, `fix/dismiss-prior-reviews`, `docs/contributing-update`. Type matches Conventional Commits (see [AGENTS.md §4](AGENTS.md) for the type list).

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). Subject under 70 chars. Body explains why.

**Accept:**
```
fix(github): pass numeric status codes to plugin-retry doNotRetry

`@octokit/plugin-retry` compares `error.status` (a number) against
`doNotRetry` entries via Array.includes (strict equality). We were
passing strings, so 4xx never short-circuited.
```

**Reject:**
```
feat: comprehensive improvements to error handling
```

The first one tells the reader what changed and why. The second tells the reader nothing.

Don't over-engineer this for trivial changes — `fix typo` is fine for a typo.

### PR checklist

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) has the full list. In short, all four must be green locally before requesting review:

```sh
npx tsc --noEmit
npm test -- --run
npm run build
npm run verify-dist
```

User-facing changes also need a `CHANGELOG.md` entry under `## [Unreleased]`. Cite measurements if you have them (cost, recall, latency).

### Coding standards

Substantive expectations — types, comments, error handling, logging, architecture invariants — are in **[AGENTS.md §1–§2](AGENTS.md)**. The big ones:

- Comments explain **why**, not what. The code already says what.
- No `any`; no `console.log` in production; no swallowed exceptions; no `dist/` hand-edits.
- No imports from `src/eval/*` into `src/!(eval)/*` — `verify-dist` enforces this.
- New dependencies need a justification in the PR description. Every dep ships in the action bundle.

### Receiving review feedback

Codex reviews every PR to this repo. Treat its comments the same as a human reviewer's:

1. Read the comment in full before responding
2. Decide if you agree. If not, explain why in the thread (cite the line, name the wrong premise) — reviewers can be wrong, but disagreement needs evidence
3. If you fix it, the commit message should reference the comment ID (`Codex P2 #3311224941`)
4. Reply on the thread with what you changed (or why you didn't). Resolve the thread.

This pattern keeps the codebase self-documenting about *why* non-obvious decisions were made.

### Dogfooding

Self-review is **manual** ([`.github/workflows/self-review.yml`](.github/workflows/self-review.yml) is `workflow_dispatch` only — the auto-trigger on `pull_request` was disabled to prevent feedback loops on prompt-iteration PRs). A maintainer dispatches one on PRs that touch the prompt, tools, or scanners — and on anything else where dogfooding the change is worth the credits.

To run one yourself, ask a maintainer to dispatch: `gh workflow run self-review.yml -f pr_number=<your-PR> -R driches/code-review`. The job posts a review on the PR within a few minutes.

**If the self-review flags something, read it.** It's not a CI gate, but it usually catches at least one thing worth thinking about. Push back in the thread if you disagree, or file a [`review-quality`](https://github.com/driches/code-review/issues/new?template=review_quality.yml) issue so calibration improves.

If your change touches the agent prompt, scanners, or tools in `src/tools/`, run a few representative PRs through it manually first using `npm run local-review` — the regression risk is highest there. See [AGENTS.md §3](AGENTS.md) for the eval workflow.

## Architecture

The agent has no built-in tools — only the custom tools in `src/tools/`. The single output channel is `post_inline_comment`, which validates the `(file_path, line)` against the PR diff before accepting. The agent terminates with `post_summary`.

Full architecture invariants — what the orchestrator owns, when to add a scanner vs. an agent capability, the `OrchestratorOutput.kept_comments` eval contract — are in [AGENTS.md §2](AGENTS.md).

## Releasing

Maintainer-only. Full sequence in [AGENTS.md §8](AGENTS.md). Summary:

1. Bump version in `package.json` and `package-lock.json`
2. Move `## [Unreleased]` content to a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`
3. `npm run build && npm run verify-dist` — must be clean
4. Open release PR, merge
5. From main: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
6. The `release.yml` workflow handles the GitHub release and moves the major tag (`v0`)

## Getting help

- [GitHub Discussions](https://github.com/driches/code-review/discussions) — questions, design feedback, anything that isn't a bug or feature request
- [SUPPORT.md](SUPPORT.md) — full routing map
- [SECURITY.md](SECURITY.md) — vulnerabilities (please don't file public issues for these)
