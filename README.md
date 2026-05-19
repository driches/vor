# Claude Code Review

> AI-powered PR code review GitHub Action. Posts inline review comments with concrete code suggestions, anchored to real lines in the diff — like Codex review, but Claude.

Built on the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) with a custom tool-use loop. The agent has access to a constrained set of 9 custom tools (read PR diff, read file at ref, grep the checkout, post inline comments, post summary) and **no built-in filesystem/shell access**. The single output tool, `post_inline_comment`, validates `(file_path, line)` against the actual diff before accepting — so the agent **cannot post on lines that don't exist**, and on rejection it gets a structured hint listing the real reviewable lines so it self-corrects.

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
      - uses: driches/code-review@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Open a PR and a sticky review appears within a few minutes. On each push, the prior review is dismissed and a fresh one is posted against the new HEAD.

## What you get

Every review has:

- **Inline comments** anchored to specific lines (not a wall of text at the bottom)
- **Severity tags** — `[CRITICAL · bug]`, `[IMPORTANT · security]`, `[MINOR · readability]`
- **Concrete suggestions** in `` ```suggestion `` blocks (one-click apply) for any critical/important finding
- **A "why it matters"** sentence — user impact or maintainability cost, not "this is wrong"
- **A summary** with 1-5 strengths, an assessment (Approve / Comment / Request changes), and reasoning

By default, the agent **never auto-blocks** — all reviews are posted as `COMMENT`. To opt into `REQUEST_CHANGES` on critical findings, see Configuration below.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | yes | — | Anthropic API key. Store as a repo secret. |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` permission. |
| `model` | no | `claude-sonnet-4-6` | Claude model ID. Override per-repo via config. |
| `max_turns` | no | `40` | Max agent turns. Larger PRs may need more. |
| `config_path` | no | `.code-review.yml` | Path in consumer repo to optional config. |
| `dry_run` | no | `false` | If `true`, logs the review instead of posting. |
| `pr_number` | no | (auto) | PR number; auto-detected from `pull_request` events. |

## Outputs

| Output | Description |
|---|---|
| `review_id` | GitHub ID of the review that was created. |
| `comment_count` | Number of inline comments posted. |
| `ended` | `summary_posted` / `max_turns` / `budget_exceeded` / `aborted` / `error`. |
| `cost_usd` | Total Anthropic API cost in USD. |

## Per-repo config (`.code-review.yml`)

All fields optional. Defaults are sensible.

```yaml
model: claude-sonnet-4-6
max_turns: 40

exclude:
  paths:
    - "**/*.lock"
    - "dist/**"
    - "**/__generated__/**"
  max_diff_lines_per_file: 1500

focus:
  security: true
  performance: true
  correctness: true
  style: false      # default off — style is noisy
  tests: true
  docs: false

severity:
  floor: minor                     # critical | important | minor | nit
  max_comments_per_file: 5
  max_comments_total: 30

context:
  include:
    - AGENTS.md
    - CLAUDE.md
    - docs/architecture.md
  max_context_bytes: 50000

prompt:
  additions: |
    This codebase uses React Server Components. Flag any "use client"
    that isn't strictly necessary. We do not use class components.

review:
  event: COMMENT                   # COMMENT | REQUEST_CHANGES | APPROVE
  sticky: true                     # dismiss prior agent reviews on each push
  post_summary: true

budget:
  max_input_tokens: 500000
  max_output_tokens: 50000
```

## How it works (the short version)

1. The action fetches PR metadata, the file list, and the full unified diff.
2. It computes **reviewable_line_ranges** for each file (added lines + context inside hunks).
3. It loads `.code-review.yml` and convention files (CLAUDE.md, AGENTS.md, etc.) from the PR HEAD.
4. It builds a system prompt that includes severity calibration + repo conventions.
5. The agent loop runs with **9 custom tools** and **no built-in tools**:
   - Read: `get_pr_metadata`, `list_changed_files`, `get_pr_diff`, `read_file_at_ref`, `grep_repo_at_ref`, `read_repo_context_file`
   - Write: `post_inline_comment` (validated), `post_summary` (terminates), `skip_file`
6. Every `post_inline_comment` runs through a validator. On rejection (line outside diff, missing suggestion for high severity, duplicate, etc.), the agent gets a structured `{ reason, hint }` so it can correct and retry.
7. After `post_summary`, the action filters by severity floor + per-file/global caps, dismisses any prior reviews from this agent on the PR (sticky), and posts a single review via `octokit.pulls.createReview`.

## Why this works when "ask Claude to review the PR" doesn't

The three failure modes that previous attempts kept hitting:

1. **Output is prose, not actionable** → The agent has no `text` output channel. Findings can only be surfaced via `post_inline_comment`. Stdout is logged for debugging but invisible to the PR.
2. **Comments don't land inline** → The action uses `pulls.createReview` with a `comments[]` array, with `path` + `line` + `side` + ` ```suggestion ` blocks.
3. **Hallucinated lines** → The validator rejects any `(path, line)` outside `reviewable_lines`, returning the actual valid ranges as a hint so the agent self-corrects.

## Development

```sh
nvm use            # node 20
npm install
npm run typecheck
npm test
npm run build
npm run verify-dist
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev workflow.

## License

MIT
