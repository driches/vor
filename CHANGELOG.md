# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
