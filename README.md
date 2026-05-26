# Claude Code Review

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Claude Code Review" width="420">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/driches/code-review/actions/workflows/ci.yml"><img src="https://github.com/driches/code-review/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/driches/code-review/releases"><img src="https://img.shields.io/github/v/release/driches/code-review?include_prereleases&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/driches/code-review" alt="MIT License"></a>
  <a href="https://github.com/marketplace/actions/claude-code-review"><img src="https://img.shields.io/badge/Marketplace-GitHub%20Action-2088FF?logo=github" alt="GitHub Marketplace"></a>
  <a href="https://github.com/driches/code-review/discussions"><img src="https://img.shields.io/github/discussions/driches/code-review" alt="Discussions"></a>
</p>

> AI-powered PR code review GitHub Action **with parallel vulnerability scanning**. Posts inline review comments with concrete code suggestions, anchored to real lines in the diff — like Codex review, but Claude — and now flags known CVEs in your lockfiles and hardcoded secrets in your diff alongside the AI's findings, in the same review.

Built on the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) with a custom tool-use loop. The agent has access to a constrained set of 9 custom tools (read PR diff, read file at ref, grep the checkout, post inline comments, post summary) and **no built-in filesystem/shell access**. The single output tool, `post_inline_comment`, validates `(file_path, line)` against the actual diff before accepting — so the agent **cannot post on lines that don't exist**, and on rejection it gets a structured hint listing the real reviewable lines so it self-corrects.

In parallel with the AI review, two deterministic scanners run:

- **`dependency-cve`** parses changed lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`) and queries [OSV.dev](https://osv.dev) for known CVEs. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · GHSA-…_`.
- **`secrets`** scans added lines in the diff for ~14 high-confidence credential patterns (AWS keys, GitHub PATs, Slack tokens, Stripe keys, Google API keys, npm tokens, PEM private keys). Matches are masked before posting.

Scanner findings flow through the same severity floor / per-file cap / global cap pipeline as AI comments and post in the same single PR review.

## Quick start

In any of your repos, add `.github/workflows/code-review.yml`:

```yaml
name: Code Review
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true

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
          pr_number: ${{ inputs.pr_number }}
```

Trigger a review by hand: **Actions → Code Review → Run workflow → enter PR number**. A sticky review appears within a few minutes; re-run to refresh against the new HEAD.

### Why manual-only?

The action refuses to run on `pull_request` / `pull_request_target` events by default. The auto-trigger pattern produces tight iteration loops (every push reviews, every review can be acted on, every action push re-reviews) that we found generated more noise than signal in practice. Manual invocation gives you control over when to spend tokens.

If you've explicitly decided the auto-trigger economics work for your repo, opt in:

```yaml
- uses: driches/code-review@v0
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    allow_auto_trigger: 'true'
```

…and use `on: pull_request:` as you would expect.

## What you get

Every review has:

- **Inline comments** anchored to specific lines (not a wall of text at the bottom)
- **Severity tags** — `[CRITICAL · bug]`, `[IMPORTANT · security]`, `[MINOR · readability]`
- **Concrete suggestions** in `` ```suggestion `` blocks (one-click apply) for any critical/important finding
- **A "why it matters"** sentence — user impact or maintainability cost, not "this is wrong"
- **A summary** with 1-5 strengths, an assessment (Approve / Comment / Request changes), and reasoning
- **Scanner findings** for known CVEs and leaked secrets, with provenance tags like `_via OSV · GHSA-jf85-cpcp-j695_` or `_via secrets scan_`, plus a "Security: N findings" line in the summary

By default, the agent **never auto-blocks** — all reviews are posted as `COMMENT`. To opt into `REQUEST_CHANGES` on critical findings, see Configuration below.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | no | — | Anthropic API key. Store as a repo secret. Required for the default Claude models; omit entirely for OpenAI-only setups (the orchestrator picks the key matching the resolved provider). |
| `openai_api_key` | no | — | OpenAI API key. Required when `model` is an OpenAI id (recommended: `gpt-5.4-mini`; alternatives include `gpt-5.4`, `gpt-5.5`, `gpt-4.1`, `o4-mini`). |
| `provider` | no | (inferred) | LLM provider override (`anthropic` \| `openai`). Inferred from `model` when omitted (`claude-*` → anthropic, `gpt-*`/`o<digit>*` → openai). |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` permission. |
| `model` | no | `claude-sonnet-4-6` | Model ID. Claude options: `claude-sonnet-4-6` (default), `claude-haiku-4-5` (lower cost), `claude-opus-4-7` (higher capability). OpenAI recommendation: `gpt-5.4-mini` for cost/recall; larger `gpt-5.5` did not improve the current golden case enough to justify the cost. |
| `max_turns` | no | `40` | Max agent turns. Larger PRs may need more. |
| `config_path` | no | `.code-review.yml` | Path in consumer repo to optional config. |
| `dry_run` | no | `false` | If `true`, logs the review instead of posting. |
| `pr_number` | no | (auto) | PR number; auto-detected from `pull_request` events. |

## Outputs

| Output | Description |
|---|---|
| `review_id` | GitHub ID of the review that was created. |
| `comment_count` | Number of inline comments posted. |
| `ended` | `summary_posted` / `max_turns` / `output_truncated` / `budget_exceeded` / `aborted` / `error` / `skipped_draft` / `skipped_no_key_anthropic` / `skipped_no_key_openai`. `output_truncated` means the response hit the per-request output token cap mid-stream — bump `budget.max_output_tokens` rather than `max_turns`. |
| `cost_usd` | Total LLM API cost in USD. |

## Per-repo config (`.code-review.yml`)

All fields optional. Defaults are sensible.

```yaml
model: claude-sonnet-4-6  # Claude: claude-sonnet-4-6 | claude-haiku-4-5 | claude-opus-4-7
                          # OpenAI: gpt-5.4-mini (recommended) | gpt-5.4 | gpt-5.5 | gpt-4.1 | o4-mini | …
# provider: openai        # optional — only needed when `model` doesn't match a known prefix
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

providers:
  openai:
    # Optional OpenAI Responses API controls. Omit to use conservative defaults.
    # service_tier: flex                 # lower cost, slower/less available
    # prompt_cache_key: owner/repo       # stable low-cardinality cache routing key
    # prompt_cache_retention: 24h        # in_memory | 24h, model-dependent
    # reasoning_effort: low              # reasoning-capable models only
    # text_verbosity: low                # GPT-5 text verbosity knob

security:
  enabled: true                                       # set false to skip all scanners
  ignore_file: .code-review/security-ignore.yml
  scanners:
    dependency_cve:
      enabled: true
      # osv_endpoint: https://osv.example.com          # optional self-hosted mirror
    secrets:
      enabled: true
      include_generic_entropy: false                  # opt-in; high false-positive rate
    sast:           { enabled: false }                # v2 — stub in v1
    container_cve:  { enabled: false }                # v2 — stub in v1
  cache:       { enabled: true }
  persistence: { enabled: false }                     # v2 hook point
```

## Security scanning

### Scope (v1)

- **Dependency CVEs**: npm (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) and PyPI (`requirements.txt` — only `==`-pinned lines). Queries the OSV.dev `/v1/querybatch` and `/v1/vulns/{id}` endpoints. No auth, no account, no per-call cost.
- **Secrets**: AWS access keys (`AKIA…`), AWS secret keys (entropy-gated), GitHub classic + fine-grained PATs (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack tokens (`xox[baprs]-`), Stripe live/restricted keys (`sk_live_`, `rk_live_`), Google API keys (`AIza…`), npm tokens (`npm_…`), PEM private key headers, JSON Web Tokens (`eyJ…`-prefixed 3-segment shape). Only **added lines** in the diff are scanned — pre-existing secrets in untouched code are out of scope for this PR.
- **SAST + container scanning**: stubs in v1; not yet active. The slots in `.code-review.yml` are reserved so v2 can plug them in without breaking your config.

### Suppressing findings — `.code-review/security-ignore.yml`

Commit this file to your repo to suppress specific findings. All entry types support a required `reason` and an optional `expires` (`YYYY-MM-DD` or full RFC3339 timestamp). Expired entries still suppress the finding but emit a notice in the run log so you don't forget to revisit them.

```yaml
entries:
  # Suppress a specific GHSA across any package
  - ghsa_id: GHSA-xxxx-xxxx-xxxx
    reason: "Internal-only service, no external input"
    expires: 2026-12-31

  # Suppress a specific CVE
  - cve_id: CVE-2025-12345
    reason: "Patch shipped in v2.1.0"

  # Suppress by package + semver range (npm or PyPI)
  - package:
      name: lodash
      ecosystem: npm           # npm | PyPI
      version: ">=4.17.20 <4.18.0"
    reason: "Vendor pin until next major"

  # Suppress secrets in a specific file (e.g. test fixtures)
  - file: src/__fixtures__/aws-test-key.txt
    rule: "secret:aws-access-key-id"
    reason: "Synthetic test fixture, never deployed"
```

Supported `rule` values for `file` entries:
- Secrets: `secret:aws-access-key-id`, `secret:aws-secret-access-key`, `secret:github-pat-classic`, `secret:github-pat-fine-grained`, `secret:slack-token`, `secret:stripe-live-key`, `secret:google-api-key`, `secret:npm-token`, `secret:private-key-pem`, etc. (full list in [`src/scanners/secrets-patterns.ts`](src/scanners/secrets-patterns.ts))
- Dependency CVEs: `osv:<id>` (e.g. `osv:GHSA-jf85-cpcp-j695`)

If the ignore file is missing, malformed, or fails schema validation, the action degrades to "no suppressions" and logs a warning — a typo in the ignore file will **never** block your code review.

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

## Contributing

Issues and PRs welcome. Good first contributions: pick something tagged [`good first issue`](https://github.com/driches/code-review/labels/good%20first%20issue) or [`help wanted`](https://github.com/driches/code-review/labels/help%20wanted), comment "I'll take this", and send a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the dogfood workflow, and the release process. By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Support

- **Questions, ideas, show-and-tell** → [GitHub Discussions](https://github.com/driches/code-review/discussions)
- **Bugs, feature requests, review-quality feedback** → [Open an issue](https://github.com/driches/code-review/issues/new/choose)
- **Anything else** → [SUPPORT.md](SUPPORT.md)

## Security

See [SECURITY.md](SECURITY.md). Please don't file public issues for vulnerabilities — use [GitHub Security Advisories](https://github.com/driches/code-review/security/advisories/new) instead.

## License

MIT
