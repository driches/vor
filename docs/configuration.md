# Configuration

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | no | — | Anthropic API key. Store as a repo secret. Required when using a Claude model (the default). |
| `openai_api_key` | no | — | OpenAI API key. Required when `model` is an OpenAI model (`gpt-*`, `o<digit>*`, `chatgpt-*`). |
| `provider` | no | (inferred) | LLM provider override (`anthropic` \| `openai`). Inferred from `model` when omitted. |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` permission. |
| `model` | no | `claude-sonnet-4-6` | Model ID. Anthropic: `claude-sonnet-4-6` (default), `claude-haiku-4-5` (lower cost), `claude-opus-4-7` (higher capability). OpenAI: `gpt-4.1`, `gpt-4o-mini`, `o4-mini`, etc. |
| `max_turns` | no | `40` | Max agent turns. Larger PRs may need more. |
| `config_path` | no | `.vor.yml` | Path in consumer repo to optional config file. |
| `dry_run` | no | `false` | If `true`, logs the review instead of posting. |
| `pr_number` | no | (auto) | PR number; auto-detected from `pull_request` events. |
| `allow_auto_trigger` | no | `true` | Set to `false` to restrict to manual `workflow_dispatch` triggers only. See [Trigger options](https://driches.github.io/vor/triggers/) for details. |

> **Codex models:** OpenAI ids prefixed `gpt-` (e.g. `gpt-5-codex`) are inferred automatically. A bare `codex-*` id isn't matched by the prefix rules — set `provider: openai` explicitly for those.

## Action outputs

| Output | Description |
|---|---|
| `review_id` | GitHub ID of the review that was created. |
| `comment_count` | Number of inline comments posted. |
| `ended` | `summary_posted` / `max_turns` / `output_truncated` / `budget_exceeded` / `aborted` / `error` / `skipped_draft` / `skipped_no_key_anthropic` / `skipped_no_key_openai`. `output_truncated` means the response hit the per-request output token cap mid-stream — bump `budget.max_output_tokens` rather than `max_turns`. |
| `cost_usd` | Total LLM API cost in USD for this run. |

## Per-repo config (`.vor.yml`)

Drop this file at the root of any repo Vor reviews to control its behavior. All fields are optional — Vor has sensible defaults.

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

> **OCR assets.** `image_ocr` and the OCR half of `describe_image_at_ref` need the bundled `tesseract.js` runtime and vendored language/WASM assets under `assets/ocr/` (see that directory's README). When absent they degrade to "no text" rather than failing the review. The vision half needs no local assets — it calls the configured model.
