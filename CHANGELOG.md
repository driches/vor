# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Token cost reductions** (expected ~15–20× on typical multi-turn reviews):
  - **Prompt caching on tools + message-history prefix.** The agent loop now sets `cache_control: ephemeral` on the last tool definition (tools don't change across turns) and slides a single cache breakpoint forward onto the latest user message before each API call. This caches the growing conversation prefix (assistant turns + tool results, which can include 100KB diffs and 500-line file reads) so it reads from cache at ~$0.30/M instead of being re-billed at the full $3/M input rate every turn. Zero behavior change — only billing changes.
  - **Default `max_turns` lowered 40 → 15.** The agent's review process (metadata → context → list files → diff → ~5 verifications → comments → summary) converges in 10–15 turns; the old 40-turn budget compounded cost when the agent meandered. Override per-repo in `.code-review.yml` if your reviews end with `ended: max_turns`.
  - **Default model switched `claude-sonnet-4-6` → `claude-haiku-4-5`.** Haiku is ~3× cheaper on both input and output. Sonnet and Opus remain opt-in via `model:` in `.code-review.yml`. Operators who depend on Sonnet-level recall should validate via `npm run golden:eval` before relying on the new default.

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
