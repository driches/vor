# Configuration

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | no | — | Anthropic API key. Store as a repo secret. Required when using a Claude model (the default). |
| `openai_api_key` | no | — | OpenAI API key. Required when `model` is an OpenAI model (`gpt-*`, `o<digit>*`, `chatgpt-*`). OpenAI-only setups default to `gpt-5.6-sol`. |
| `provider` | no | (inferred) | LLM provider override (`anthropic` \| `openai`). Inferred from `model` when omitted. |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` permission. |
| `model` | no | `claude-sonnet-4-6` | Model ID. Anthropic: `claude-sonnet-4-6` (overall default), `claude-haiku-4-5`, `claude-opus-4-7`. OpenAI: `gpt-5.6-sol` (provider default and highest quality), `gpt-4.1`, `gpt-4o-mini`, `o4-mini`, etc. |
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
| `cost_usd` | Estimated LLM API cost in USD for this run, using Vor's pricing catalog. |

## Per-repo config (`.vor.yml`)

Drop this file at the root of any repo Vor reviews to control its behavior. All fields are optional — Vor has sensible defaults.

```yaml
model: claude-sonnet-4-6  # Claude: claude-sonnet-4-6 | claude-haiku-4-5 | claude-opus-4-7
                          # OpenAI: gpt-5.6-sol | gpt-4.1 | gpt-4o-mini | o4-mini | …
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
  post_summary: true               # false = inline comments only, no summary body

budget:
  max_input_tokens: 500000
  max_output_tokens: 50000

providers:
  openai:
    # Optional OpenAI Responses API controls. Omit to use conservative defaults.
    # service_tier: flex                 # lower cost, slower/less available
    # prompt_cache_key: owner/repo       # stable low-cardinality cache routing key
    # prompt_cache_retention: 24h        # in_memory | 24h, model-dependent
    # reasoning_effort: low              # none | minimal | low | medium | high | xhigh | max
    # unsafe_reasoning_effort_override: future-value
    #                                      # explicit escape hatch; see below
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
    sast:           { enabled: true }                 # on by default since v0.4.0; set false to disable
    container_cve:  { enabled: false }                # v2 — not yet active
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

### OpenAI reasoning controls

For the highest-quality supported OpenAI configuration, use the normal,
validated field:

```yaml
model: gpt-5.6-sol
provider: openai
providers:
  openai:
    reasoning_effort: max
```

`reasoning_effort` is a closed catalog: `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`. Unknown values and misspelled provider keys fail
validation; strict `vor config validate` reports the error, while review paths
using safe loading warn and fall back to the full default configuration.
Individual models may support only a subset; `gpt-5.6-sol` supports `max`.

If OpenAI documents a future effort value before Vor adds it, an operator can
explicitly opt out of catalog validation with
`unsafe_reasoning_effort_override`. It accepts only a short, log-safe provider
identifier, cannot be combined with `reasoning_effort`, is preserved in
`vor config show` and MCP `get_config` output, and emits a warning before a
review. The override forces the reasoning request shape, but Vor cannot
validate provider/model compatibility or cost impact; an unsupported value may
make the provider reject the request. Do not use this field to guess values.

GPT-5.6 Pro mode is not an effort value and is not exposed by Vor. Do not set
`reasoning_effort: pro` or route `pro` through the unsafe override. Pro needs a
separate `reasoning.mode` control and a validated multi-turn tool-call path
before Vor can support it.

GPT-5.6 uses OpenAI's current prompt-cache options rather than the legacy
`prompt_cache_retention` request field, so omit that field for GPT-5.6. Cost
reporting includes GPT-5.6 Sol's base input, output, cache-read, and cache-write
rates. OpenAI's whole-request surcharge above 272,000 input tokens is not yet
represented by Vor's aggregate per-model accounting, so `cost_usd` can
underestimate those unusually large requests. See OpenAI's
[GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
and [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
for current provider behavior and rates.

> **OCR assets.** `image_ocr` and the OCR half of `describe_image_at_ref` need the bundled `tesseract.js` runtime and vendored language/WASM assets under `assets/ocr/` (see that directory's README). When absent they degrade to "no text" rather than failing the review. The vision half needs no local assets — it calls the configured model.
