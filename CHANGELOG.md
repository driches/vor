# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
