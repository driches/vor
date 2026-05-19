# Contributing

## Development setup

```sh
nvm use            # node 20
npm install
npm run typecheck
npm test
npm run build      # bundles src/ → dist/index.js via esbuild
```

## Architecture

The agent has no built-in tools — only the custom tools in `src/tools/`. The single output channel is `post_inline_comment`, which validates the `(file_path, line)` against the PR diff before accepting. The agent terminates with `post_summary`.

Module map: see [`docs/architecture.md`](docs/architecture.md) (TBD).

## Releasing

1. Bump version in `package.json` and update `CHANGELOG.md`.
2. `npm run build` (must produce a clean `dist/index.js` diff).
3. Tag and push: `git tag v1.2.3 && git push --tags`.
4. The `release.yml` workflow handles the GitHub release and moves the major tag (`v1`).

## Dogfooding

Every PR against this repo runs the action against itself via `.github/workflows/self-review.yml` (`uses: ./`). This catches regressions before release and gives us a corpus of real reviews to evaluate prompt quality.
