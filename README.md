# Claude Code Review

> AI-powered PR code review GitHub Action. Posts inline review comments with concrete code suggestions, anchored to real lines in the diff.

Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). The agent has access to a constrained set of custom tools — read PR diff, read file content at a ref, grep the repo, post inline comments, post a summary — and can only surface findings via `post_inline_comment`. The tool validates that the `(file_path, line)` is inside the PR's diff before accepting, so the agent cannot post on lines that don't exist or aren't reviewable.

## Quick start

In any of your repos, add `.github/workflows/code-review.yml`:

```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: driches/code-review@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Open a PR and a sticky review will be posted within a few minutes.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | yes | — | Anthropic API key (store as a repo secret) |
| `github_token` | no | `${{ github.token }}` | Token with `pull-requests: write` |
| `model` | no | `claude-sonnet-4-6` | Claude model ID |
| `max_turns` | no | `40` | Max agent turns per review |
| `config_path` | no | `.code-review.yml` | Path to optional per-repo config |
| `dry_run` | no | `false` | Log review instead of posting |

## Per-repo config

Add a `.code-review.yml` at your repo root to tune behavior. See [`docs/config.md`](docs/config.md) (TBD) for the full schema.

## Status

Early development. See [the implementation plan](https://github.com/driches/code-review/blob/main/PLAN.md) for what's built and what's next.

## License

MIT
