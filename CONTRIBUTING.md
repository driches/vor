# Contributing

Thanks for thinking about contributing. This is a small project — issues, PRs, and review-quality reports are all genuinely useful, and "I tried the action and here's what felt off" feedback in [Discussions](https://github.com/driches/code-review/discussions) is just as welcome as code.

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

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

`<type>/<short-description>` — e.g. `feat/exclude-paths-glob`, `fix/dismiss-prior-reviews`, `docs/contributing-update`. Type matches Conventional Commits.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) where it's natural:

- `feat: add priority_paths config field`
- `fix: handle empty diff without crashing`
- `docs: clarify cost budget defaults`
- `chore(deps): bump octokit-rest to v22`

Don't over-engineer this — `fix typo` is fine for a typo.

### PR checklist

The PR template has the full list, but in short:

- `npm run typecheck && npm test` pass
- If you changed `src/`, also `npm run build && npm run verify-dist`
- If user-facing, update `CHANGELOG.md` under `## [Unreleased]`
- Description explains the *why*, not just the *what*

### Dogfooding (read this if you're changing the prompt or tools)

Every PR against this repo runs the action against itself via [`.github/workflows/self-review.yml`](.github/workflows/self-review.yml) (`uses: ./`). That gives us:

- A real review on your PR before merge
- A corpus of real reviews we can compare across changes to evaluate prompt quality

If the self-review flags something on your PR, **read it.** It's not a CI gate, but it usually catches at least one thing worth thinking about. If you disagree with the AI, that's fine — push back in the PR thread or file a [`review-quality`](https://github.com/driches/code-review/issues/new?template=review_quality.yml) issue so the calibration can improve.

If your change is to the prompt or to one of the tools in `src/tools/`, run a few PRs through it manually first — the regression risk is highest there.

## Architecture

The agent has no built-in tools — only the custom tools in `src/tools/`. The single output channel is `post_inline_comment`, which validates the `(file_path, line)` against the PR diff before accepting. The agent terminates with `post_summary`.

Module map: see [`docs/architecture.md`](docs/architecture.md) (TBD — contributions welcome).

## Releasing

Maintainer-only.

1. Bump version in `package.json` and update `CHANGELOG.md`.
2. `npm run build` — must produce a clean `dist/index.js` diff.
3. Tag and push: `git tag v1.2.3 && git push --tags`.
4. The `release.yml` workflow handles the GitHub release and moves the major tag (`v1`).

## Getting help

- [Discussions](https://github.com/driches/code-review/discussions) for any question that isn't a bug or a feature request
- [SUPPORT.md](SUPPORT.md) for the full routing map
- [SECURITY.md](SECURITY.md) for vulnerabilities (please don't file public issues for these)
