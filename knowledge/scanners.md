---
type: Concept
title: Deterministic Scanners and Finding Pipeline
description: Six deterministic security scanners are enabled by default, coverage and image OCR are opt-ins, and the architecture scanner runs independently when enabled; inline findings share the review pipeline while binary OCR findings render separately.
tags: [security, architecture, scanners, cve, secrets, sast, osv]
timestamp: 2026-11-25T00:00:00Z
---

# Deterministic Scanners and Finding Pipeline

When `security.enabled` is true, six deterministic security scanners are enabled by default. [`buildEnabledScanners`](../src/scanners/registry.ts) constructs them in a stable order after applying each scanner's `enabled` flag:

- **`dependency-cve`** — parses changed npm v7+ `package-lock.json` files, Yarn Classic `yarn.lock` files, pnpm v5/v6/v9 `pnpm-lock.yaml` package entries, Python exact `==` pins in `requirements*.txt` and PyPI-resolved `poetry.lock` packages, Go `go.sum` module code lines, and crates.io `Cargo.lock` packages, then queries [OSV.dev](https://osv.dev) for known CVEs. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · <identifier>_`; the identifier preference is a CVE alias, then a GHSA alias, then the native OSV advisory ID.
- **`secrets`** — scans added lines in the diff for 21 default high-confidence credential patterns (AWS keys, classic/OAuth/fine-grained GitHub PATs, Slack tokens, Stripe live and restricted keys, Google API keys, npm tokens, Anthropic/OpenAI keys, GitLab PATs, Hugging Face tokens, SendGrid keys, DigitalOcean tokens, PEM private keys, and JWTs), with generic-entropy matching available as an opt-in. Matches are masked before posting.
- **`sast`** — fans out to the language-appropriate installed tools: ESLint, Ruff, Dart analyzer, actionlint, Knip, Semgrep, TypeScript (`tsc --noEmit`), and golangci-lint. Semgrep uses `--config=auto` and also loads `.vor/semgrep-rules/` when that configured path exists.
- **`debris`** — catches PR-added merge-conflict markers, debugger statements, focused tests, and stray debug logging.
- **`migration-safety`** — flags risky DDL in migration files, including destructive statements and adding `NOT NULL` columns without defaults.
- **`dependency-hygiene`** — inspects npm-style `package.json` manifests and reports lockfile drift, newly added open-ended or wildcard ranges (`*`, `latest`, `>=…`), and git, URL, or file dependency sources. It does not cover other manifest formats or package ecosystems.

## Opt-in and reserved security scanners

- **`coverage-delta`** — runs a detected Vitest, Jest, or pytest-cov workflow and flags uncovered PR-added lines. It is off by default because it can be slow and requires project test dependencies.
- **`image-ocr`** — OCRs committed images with bundled Tesseract assets and applies the secrets patterns to the extracted text. It is off by default because of its latency.
- **`container-cve`** — is registered in config but remains a v1 stub whose `applies()` method always returns false.

## Independent architecture scanner

- **`architecture`** ([`src/scanners/architecture.ts`](../src/scanners/architecture.ts)) — runs **independently of `security.enabled`** whenever `architecture.enabled && architecture.deterministic_enforcement` is enabled. Checks PR-added lines against configured layer dependencies, package allow/forbid rules, bounded-context boundaries, and custom rules, emitting inline findings tagged `_via architecture scan_` and a `**Architecture:**` summary line. See [standards-and-references](standards-and-references.md).

## Shared pipeline

The defaults live in [`src/config/defaults.ts`](../src/config/defaults.ts). `security.enabled` controls the security scanner track, `security.scanners.<name>.enabled` and optional `min_severity` control individual security scanners, and `architecture.enabled` / `architecture.deterministic_enforcement` control the architecture scanner. Implemented non-SAST security scanners and the architecture scanner consult `.vor/security-ignore.yml`. SAST linter findings bypass that ignore list and must instead be suppressed through the underlying linter configuration or the available SAST options.

Scanners run alongside the LLM agent by default. Inline findings are validated, deduplicated, filtered by scanner and global severity floors, and passed through the shared per-file and global caps before posting in the PR review. Partial or failed scanner runs are surfaced in a `Scanner coverage` summary block.

Binary `image-ocr` findings cannot be anchored to GitHub diff lines. After the scanner and global severity floors are applied, they bypass inline validation and the per-file and global comment caps and render in a dedicated review-summary section instead (`review.post_summary: false` suppresses the summary body and warns if any binary findings would be dropped). An [architecture](architecture.md) invariant is that scanners handle deterministic checks while the LLM handles semantic judgment.
