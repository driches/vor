# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-25

### Added
- **Agentic worker delegation (experimental, default off).** Sonnet's tool list now includes a tenth tool, `worker_check_usage_claim`, that delegates verification work to a cheap Haiku 4.5 worker. Sonnet calls it during phase 5 (verify) to check whether a symbol is unused, has a single caller, or violates a documented pattern — and gets back a structured `{ verdict, call_sites, confidence, evidence }` JSON to reason about. The worker is a single-shot text-in/JSON-out call (no nested tool loop) and shares the parent's budget. Opt-in via `experimental.worker_delegation.enabled: true` in `.code-review.yml`.
- **Validator-enforced read-before-post discipline.** When `worker_delegation` is enabled, `post_inline_comment` rejects critical/important findings unless Sonnet has called `read_file_at_ref` on the target line range earlier in the same run. Worker output does NOT count as a read. This is the "and it will check the work" half of the design — it lets us trust worker output for exploration without trusting it for final judgment. See [src/agent/validate-comment.ts](src/agent/validate-comment.ts) and [src/agent/run-context.ts](src/agent/run-context.ts).
- **Per-model cost tracking.** `Budget` now tracks token usage per model, and `RunAgentResult.perModelCost` exposes the Sonnet/Haiku split. Golden-eval runs persist `per_model_cost` in the run JSON so cost-vs-recall comparisons across delegation modes can be measured directly. `costFromUsage(model, usage)` in [src/util/pricing.ts](src/util/pricing.ts) is now the single source of truth for cost calculation (production runner + eval harness consume it).
- **`--worker-delegation` flag in `npm run golden:eval`** to A/B test the experimental delegation on the captured cases.

### Experimental ship gate (be aware before enabling)
- Flag OFF eval (default behavior): 5/7 matches = 71% recall, $1.82 — matches v0.2.2 baseline exactly. Zero regression for anyone who doesn't opt in.
- Flag ON eval: 4/7 matches = 57% recall, $2.03 (+12% cost). Recall regression of 14 percentage points vs baseline.
- Failure mode is the one the design called out: across 3 cases, Sonnet invoked the worker on only 1, and even there it didn't shorten the loop (33 turns vs 31 baseline). The system prompt language describing when to delegate isn't compelling enough yet.
- **Recommended for now: do NOT enable in production.** The infrastructure is shipped so we can iterate on the worker prompt and (next ship) add additional worker tools without another foundation PR. The flag will flip to recommended once eval data clears ≥5/7 recall with measurable cost reduction.

### Why ship anyway
- All infrastructure (per-model cost, validator hardening, worker client) is independently valuable.
- Zero behavior change on the default (opt-out) path — confirmed by the flag-OFF eval matching v0.2.2 exactly.
- The roll-back is one config flag, not a code revert.
- Iterating on the worker prompt is much faster with the infrastructure already in place.

## [0.2.2] - 2026-05-25

### Changed
- **Bumped Anthropic API `temperature` from `0.1` → `0.5`** ([src/agent/runner.ts](src/agent/runner.ts)). The 0.1 setting shipped in v0.2.1 regressed recall on the golden-eval dataset: matches dropped from 5/7 (71%) at the SDK default (1.0) to 3/7 (43%) at 0.1. One case (`orbitboard-pr-221`) went from 1 match → 0 matches (the agent reasoned itself out of flagging a real issue on an `actions/checkout@v5` mismatch), and one case (`code-review-pr-6`) hit the 40-turn budget cap mid-investigation (it had completed in 31 turns at the SDK default). 0.5 restored full 5/7 recall with no turn-cap blowouts and ~flat cost ($1.87 vs $1.82 baseline, +3%). The variance-reduction intent of v0.2.1 stands; the value was wrong.

## [0.2.1] - 2026-05-25

### Changed
- **Set Anthropic API `temperature: 0.1`** ([src/agent/runner.ts](src/agent/runner.ts)). Previously the agent loop used the SDK default (1.0), which sampled wide enough that two back-to-back runs on the same PR head could surface entirely different findings — production smoke testing on `orbitboard#226` between v0.1.2 and v0.2.0 saw an `IMPORTANT` base64-bypass finding flagged on one run and missed entirely on the next, despite the same model and same diff. 0.1 keeps the model decisive (still allowing rare token tie-breaks) without dropping to fully greedy sampling. No effect on per-request token cost.

## [0.2.0] - 2026-05-25

### Changed
- **Token cost reductions** (golden-eval-validated: ~70% reduction with zero recall regression):
  - **Prompt caching on tools + message-history prefix.** The agent loop now sets `cache_control: ephemeral` on the last tool definition (tools don't change across turns) and maintains breakpoints on the two most recent user messages, sliding them forward each turn. Two message breakpoints (system + last-tool + 2 messages = 4, the API's per-request limit) give the cache lookup a fallback anchor on high-fanout turns where Anthropic's bounded-backtrack from a single breakpoint could otherwise miss the previous boundary. The growing conversation prefix now reads from cache at the cache_read rate instead of being re-billed at the full input rate every turn. Zero behavior change — only billing changes.
  - **`cost_usd` is now model-aware** ([src/util/pricing.ts](src/util/pricing.ts)). Previously the runner hardcoded Sonnet rates, so action output and any downstream budget alerts would be wildly off when operators override the model. Pricing lives in a single shared module consumed by the production runner and the eval harness.

### Attempted but reverted (documented for posterity)

- **Default model swap to `claude-haiku-4-5`.** Reverted after golden-eval comparison on 3 captured PRs showed Haiku at 28.6% recall on critical+important findings vs Sonnet's 71.4% — Haiku posted ZERO findings on both `orbitboard-pr-213-jwt-auth` and `orbitboard-pr-221` despite Codex flagging 4 important issues across them. Haiku remains opt-in via `model:` in `.code-review.yml` for repos where the cost/recall tradeoff is acceptable.
- **Default `max_turns` lowered to 15.** Reverted after the first dogfood self-review hit `budget_exceeded` mid-investigation at the 15-turn cap. With caching dominant, the turn cap is the wrong cost lever.

### Fixed
- Review body when the agent skips `post_summary`: instead of falling back to a placeholder ("_Code review completed by … but no summary was produced._"), the formatter now synthesizes a real body from the inline findings — severity header, findings counts, truncated-comments line, and footer. When the run ended in anything other than `summary_posted` (turn limit, budget exhausted, abort, error), a prominent blockquote warning is emitted right after the severity header naming the termination reason, so a truncated run with zero findings can't be mistaken for a clean "No findings" review. The missing-`post_summary` call is also logged at warn-level in the orchestrator.

### Added
- Initial scaffold of the `driches/code-review` GitHub Action.
- Project logo (`assets/logo.svg`, `assets/logo-dark.svg`, `assets/icon.svg`) — "eye + diff lines" mark in deep purple.
- README header: logo block (with dark-mode variant via `<picture>`) and badges row (CI, latest release, license, marketplace, discussions).
- README sections: `## Contributing`, `## Support`, `## Security`.
- Governance files: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (vuln reporting policy, in-scope/out-of-scope, response SLA), `SUPPORT.md` (routing for questions, bugs, security, contributions).
- `.github/ISSUE_TEMPLATE/`: form-based templates for bug reports, feature requests, and **review-quality feedback** (project-specific, feeds prompt tuning). Blank issues disabled; contact links route to Discussions and Security Advisories.
- `.github/PULL_REQUEST_TEMPLATE.md` with checklist (typecheck, test, build, verify-dist, changelog, dogfood awareness).
- Expanded `CONTRIBUTING.md` with: how to claim issues, branch naming, Conventional Commits, dogfooding guidance, getting-help routing.
