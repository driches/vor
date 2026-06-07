# Vor

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Vor" width="420">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/driches/vor/actions/workflows/ci.yml"><img src="https://github.com/driches/vor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/driches/vor/releases"><img src="https://img.shields.io/github/v/release/driches/vor?include_prereleases&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/driches/vor" alt="MIT License"></a>
  <a href="https://github.com/marketplace/actions/vor"><img src="https://img.shields.io/badge/Marketplace-GitHub%20Action-2088FF?logo=github" alt="GitHub Marketplace"></a>
  <a href="https://github.com/driches/vor/discussions"><img src="https://img.shields.io/github/discussions/driches/vor" alt="Discussions"></a>
</p>

<p align="center">
  <strong><a href="https://driches.github.io/vor/">Documentation &amp; site →</a></strong>
</p>

> AI-powered PR code review GitHub Action **with parallel vulnerability scanning**. Runs on the LLM provider you choose — **Anthropic Claude or OpenAI (GPT / o-series)** — and posts inline review comments with concrete code suggestions, anchored to real lines in the diff, plus flags known CVEs in your lockfiles and hardcoded secrets in your diff alongside the AI's findings, in the same review.

Provider-agnostic by design: a custom tool-use loop drives the model over a constrained set of 9 custom tools (read PR diff, read file at ref, grep the checkout, post inline comments, post summary) with **no built-in filesystem/shell access** — the same loop talks to Anthropic via [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) and to OpenAI via the Responses API. The single output tool, `post_inline_comment`, validates `(file_path, line)` against the actual diff before accepting — so the agent **cannot post on lines that don't exist**, and on rejection it gets a structured hint listing the real reviewable lines so it self-corrects.

In parallel with the AI review, two deterministic scanners run:

- **`dependency-cve`** parses changed lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`) and queries [OSV.dev](https://osv.dev) for known CVEs. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · GHSA-…_`.
- **`secrets`** scans added lines in the diff for ~14 high-confidence credential patterns (AWS keys, GitHub PATs, Slack tokens, Stripe keys, Google API keys, npm tokens, PEM private keys). Matches are masked before posting.

Scanner findings flow through the same severity floor / per-file cap / global cap pipeline as AI comments and post in the same single PR review.

## Quick start

In any of your repos, add `.github/workflows/vor.yml`:

```yaml
name: Vor
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true
      model:
        description: 'Model to use'
        required: false
        default: 'claude-sonnet-4-6'
      dry_run:
        description: 'Log review instead of posting comments'
        required: false
        default: 'false'
        type: boolean

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'claude-sonnet-4-6' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

Prefer OpenAI? Swap the key and set a model — update the `default` in the dispatch input to match:

```yaml
      - uses: driches/vor@v0
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'gpt-4.1' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

The provider is inferred from the `model` id (`claude-*` → Anthropic, `gpt-*`/`o<digit>*`/`chatgpt-*` → OpenAI), so you only supply the API key for the provider you're using.

Reviews run automatically on every pull request. You can also re-run one manually — or review any PR on demand — via **Actions → Vor → Run workflow → enter PR number**.

### Opting out of auto-trigger

If you'd prefer manual control over when reviews run, remove `pull_request` from the trigger and set `allow_auto_trigger: 'false'`:

```yaml
name: Vor
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true
      model:
        description: 'Model to use'
        required: false
        default: 'claude-sonnet-4-6'
      dry_run:
        description: 'Log review instead of posting comments'
        required: false
        default: 'false'
        type: boolean

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          allow_auto_trigger: 'false'
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'claude-sonnet-4-6' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

### Trigger from a PR comment

Want to (re)trigger from the PR itself instead of the Actions tab? Add a comment-triggered workflow. It stays manual — a person types a command, so there's no per-push token spend — but re-running is just typing `/review` on the PR again.

No `allow_auto_trigger` needed: the manual-only guard blocks `pull_request*` events, and `issue_comment` isn't one of them, so a comment trigger counts as a manual invocation. Pass the PR number explicitly — on a PR comment, `github.event.issue.number` *is* the PR number.

```yaml
name: Vor (comment)
on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  # Two gates: WHO may trigger (author_association), and whether the PR's code
  # is safe to run. Vor's SAST runs your repo's own linters from the checkout
  # (e.g. node_modules/.bin/eslint — on by default), so checking out a fork
  # PR's HEAD and running Vor with secrets would execute attacker-controlled
  # code. The guard skips forks; same-repo branches need write access = trusted.
  guard:
    if: >
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '/review') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    outputs:
      same_repo: ${{ steps.head.outputs.same_repo }}
    steps:
      - id: head
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.issue.number }}
        run: |
          head="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.repo.full_name')"
          if [ "$head" = "$REPO" ]; then
            echo "same_repo=true" >> "$GITHUB_OUTPUT"
          else
            echo "same_repo=false" >> "$GITHUB_OUTPUT"
          fi

  review:
    needs: guard
    if: needs.guard.outputs.same_repo == 'true'
    runs-on: ubuntu-latest
    steps:
      # Safe to check out PR HEAD: the guard confirmed it's a same-repo (trusted)
      # branch. grep_repo_at_ref and the SAST linters run against this checkout.
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head
          fetch-depth: 0
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ github.event.issue.number }}
```

Anyone with write access then types `/review` on a PR **from a branch in your repo** to start or refresh a review against current HEAD. The "@ mention" is just a string match on the comment body — swap `/review` for `@vor` if you prefer; no bot account required.

**Security — why the fork guard.** `issue_comment` runs in your base repo with secrets and a write token in scope. Vor's SAST scanners (on by default) run your repo's own linters resolved from the checkout — e.g. `node_modules/.bin/eslint`, `ruff`, `knip` — so pointing this at a **fork** PR's HEAD would execute attacker-controlled code on the runner (a "pwn request"). The action ships an env allowlist so a malicious binary doesn't get your keys *for free*, but it's still code execution, so the `guard` job runs the review only when the PR head is in your own repo. `author_association` gates *who can trigger*, not whether the code is safe. To review external fork PRs, use a path that doesn't expose secrets to PR code — e.g. a `workflow_dispatch` that checks out a trusted ref and reviews the fork PR by number (Vor reads its diff over the API). Pin the action to a release tag or commit SHA.

## What you get

Every review has:

- **Inline comments** anchored to specific lines (not a wall of text at the bottom)
- **Severity tags** — `[CRITICAL · bug]`, `[IMPORTANT · security]`, `[MINOR · readability]`
- **Concrete suggestions** in `` ```suggestion `` blocks (one-click apply) for any critical/important finding
- **A "why it matters"** sentence — user impact or maintainability cost, not "this is wrong"
- **A summary** with 1-5 strengths, an assessment (Approve / Comment / Request changes), and reasoning
- **Scanner findings** for known CVEs and leaked secrets, with provenance tags like `_via OSV · GHSA-jf85-cpcp-j695_` or `_via secrets scan_`, plus a "Security: N findings" line in the summary

By default, the agent **never auto-blocks** — all reviews are posted as `COMMENT`. To opt into `REQUEST_CHANGES` on critical findings, see Configuration below.

## Run locally (CLI, dashboard, MCP)

Vor also runs entirely on your machine — no GitHub round-trip — so you can review
changes _before_ you push. The same orchestrator (scanners + agent) that powers the
Action runs against your local git, in dry-run mode. Set `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` first.

```sh
# Review your uncommitted changes (auto-detects working tree vs branch range)
npx @driches/vor review

# Review a branch against a base
npx @driches/vor review --range --base origin/main --head HEAD

# Browse past runs (stored under ~/.vor/runs)
npx @driches/vor runs list
npx @driches/vor runs show <id>

# Inspect the resolved .vor.yml
npx @driches/vor config show
```

Install it once for a shorter command:

```sh
npm i -g @driches/vor
vor review --json        # machine-readable output
```

### Local dashboard

A small web UI to browse run history and kick off reviews:

```sh
vor dashboard            # serves http://127.0.0.1:4310 (loopback only)
```

### MCP server

Expose Vor to agents (e.g. Claude Code) over stdio. Tools: `review_local_changes`,
`list_runs`, `get_run`, `get_config`.

```sh
claude mcp add vor -- npx -y @driches/vor mcp
```

Run history and the dashboard's assets live under `~/.vor/` (override the root with
`VOR_HOME`). Nothing is posted anywhere — local reviews are dry-run only.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | no | — | Anthropic API key. Store as a repo secret. Required when the resolved provider is Anthropic (the default model is a Claude model); omit for OpenAI-only setups. The orchestrator picks the key matching the resolved provider. |
| `openai_api_key` | no | — | OpenAI API key. Required when the resolved provider is OpenAI (e.g. `model` is `gpt-4.1`, `gpt-4o-mini`, `o4-mini`, `gpt-5-codex`). |
| `provider` | no | (inferred) | LLM provider override (`anthropic` \| `openai`). Inferred from `model` when omitted (`claude-*` → anthropic, `gpt-*`/`o<digit>*`/`chatgpt-*` → openai). |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` permission. |
| `model` | no | `claude-sonnet-4-6` | Model ID. Anthropic: `claude-sonnet-4-6` (default), `claude-haiku-4-5` (lower cost), `claude-opus-4-7` (higher capability). OpenAI: `gpt-4.1`, `gpt-4o-mini`, `o4-mini`, `gpt-5-codex`, etc. |
| `max_turns` | no | `40` | Max agent turns. Larger PRs may need more. |
| `config_path` | no | `.vor.yml` | Path in consumer repo to optional config. |
| `dry_run` | no | `false` | If `true`, logs the review instead of posting. |
| `pr_number` | no | (auto) | PR number; auto-detected from `pull_request` events. |
| `allow_auto_trigger` | no | `true` | Set to `false` to opt out of auto-runs on `pull_request` events and restrict to manual `workflow_dispatch` triggers only. `pull_request_target` is always blocked regardless of this setting (fork PRs run with base-repo secrets; a fork could spend your API key via `.vor.yml`). Review/comment events are always blocked too. |

> **Codex models:** OpenAI ids prefixed `gpt-` (e.g. `gpt-5-codex`) are inferred automatically. A bare `codex-*` id isn't matched by the prefix rules above — set `provider: openai` explicitly for those.

## Outputs

| Output | Description |
|---|---|
| `review_id` | GitHub ID of the review that was created. |
| `comment_count` | Number of inline comments posted. |
| `ended` | `summary_posted` / `max_turns` / `output_truncated` / `budget_exceeded` / `aborted` / `error` / `skipped_draft` / `skipped_no_key_anthropic` / `skipped_no_key_openai`. `output_truncated` means the response hit the per-request output token cap mid-stream — bump `budget.max_output_tokens` rather than `max_turns`. |
| `cost_usd` | Total LLM API cost in USD. |

## Per-repo config (`.vor.yml`)

All fields optional. Defaults are sensible.

```yaml
model: claude-sonnet-4-6  # Claude: claude-sonnet-4-6 | claude-haiku-4-5 | claude-opus-4-7
                          # OpenAI: gpt-4.1 | gpt-4o-mini | o4-mini | …
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
  ignore_file: .vor/security-ignore.yml
  scanners:
    dependency_cve:
      enabled: true
      # osv_endpoint: https://osv.example.com          # optional self-hosted mirror
    secrets:
      enabled: true
      include_generic_entropy: false                  # opt-in; high false-positive rate
    sast:           { enabled: false }                # v2 — stub in v1
    container_cve:  { enabled: false }                # v2 — stub in v1
    image_ocr:                                        # off by default
      enabled: false                                  # OCR committed images, scan extracted text for secrets
      # max_image_bytes: 10485760                     # skip images larger than this
      # languages: [eng]                              # tesseract language packs
  cache:       { enabled: true }
  persistence: { enabled: false }                     # v2 hook point

# Visual understanding of images via a cost-effective vision model. Off by
# default — each call spends image-input tokens. Powers the
# `describe_image_at_ref` agent tool (OCR text + a short description of what the
# image shows). Anthropic provider only; OpenAI consumers get OCR-only.
image_understanding:
  enabled: false
  # model: claude-haiku-4-5                           # default cheap vision model
  # max_images: 10                                    # cap vision calls per run
```

> **OCR assets.** `image_ocr` and the OCR half of `describe_image_at_ref` need
> the bundled `tesseract.js` runtime and vendored language/WASM assets under
> `assets/ocr/` (see that directory's README). When absent they degrade to
> "no text" rather than failing the review. The vision half needs no local
> assets — it calls the configured model.

## Security scanning

### Scope (v1)

- **Dependency CVEs**: npm (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) and PyPI (`requirements.txt` — only `==`-pinned lines). Queries the OSV.dev `/v1/querybatch` and `/v1/vulns/{id}` endpoints. No auth, no account, no per-call cost.
- **Secrets**: AWS access keys (`AKIA…`), AWS secret keys (entropy-gated), GitHub classic + fine-grained PATs (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack tokens (`xox[baprs]-`), Stripe live/restricted keys (`sk_live_`, `rk_live_`), Google API keys (`AIza…`), npm tokens (`npm_…`), PEM private key headers, JSON Web Tokens (`eyJ…`-prefixed 3-segment shape). Only **added lines** in the diff are scanned — pre-existing secrets in untouched code are out of scope for this PR.
- **Static analysis (SAST)**: enabled by default. Runs the repo's own linters against changed files and surfaces findings inline at zero token cost — ESLint, `tsc`, and knip (JavaScript / TypeScript), Ruff (Python), `dart analyze` (Dart), golangci-lint (Go), actionlint (GitHub Actions workflows), and Semgrep (`--config=auto` plus any custom rules under `.vor/semgrep-rules/`). Each linter runs only when its tool is available in the repo, so it stays silent on stacks it doesn't apply to. Disable all of it with `security.scanners.sast.enabled: false`.
- **Container scanning**: stub in v1; not yet active. The `.vor.yml` slot is reserved so v2 can plug it in without breaking your config.

### Suppressing findings — `.vor/security-ignore.yml`

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
3. It loads `.vor.yml` and convention files (CLAUDE.md, AGENTS.md, etc.) from the PR HEAD.
4. It builds a system prompt that includes severity calibration + repo conventions.
5. The agent loop runs with **9 custom tools** and **no built-in tools**:
   - Read: `get_pr_metadata`, `list_changed_files`, `get_pr_diff`, `read_file_at_ref`, `grep_repo_at_ref`, `read_repo_context_file`
   - Write: `post_inline_comment` (validated), `post_summary` (terminates), `skip_file`
6. Every `post_inline_comment` runs through a validator. On rejection (line outside diff, missing suggestion for high severity, duplicate, etc.), the agent gets a structured `{ reason, hint }` so it can correct and retry.
7. After `post_summary`, the action filters by severity floor + per-file/global caps, dismisses any prior reviews from this agent on the PR (sticky), and posts a single review via `octokit.pulls.createReview`.

## Why this works when "ask the AI to review the PR" doesn't

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

Issues and PRs welcome. Good first contributions: pick something tagged [`good first issue`](https://github.com/driches/vor/labels/good%20first%20issue) or [`help wanted`](https://github.com/driches/vor/labels/help%20wanted), comment "I'll take this", and send a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the dogfood workflow, and the release process. By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Support

- **Questions, ideas, show-and-tell** → [GitHub Discussions](https://github.com/driches/vor/discussions)
- **Bugs, feature requests, review-quality feedback** → [Open an issue](https://github.com/driches/vor/issues/new/choose)
- **Anything else** → [SUPPORT.md](SUPPORT.md)

## Security

See [SECURITY.md](SECURITY.md). Please don't file public issues for vulnerabilities — use [GitHub Security Advisories](https://github.com/driches/vor/security/advisories/new) instead.

## License

MIT
