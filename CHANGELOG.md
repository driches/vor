# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
