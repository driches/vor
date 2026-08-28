---
type: Concept
title: Deterministic Scanners and Finding Pipeline
description: Six deterministic scanners are enabled by default, with coverage and image OCR available as opt-ins; inline findings share the review pipeline while binary OCR findings render separately.
tags: [security, scanners, cve, secrets, sast, osv]
timestamp: 2026-07-20T00:00:00Z
---

# Deterministic Scanners and Finding Pipeline

When `security.enabled` is true, six deterministic scanners are enabled by default. [`buildEnabledScanners`](../src/scanners/registry.ts) constructs them in a stable order after applying each scanner's `enabled` flag:

- **`dependency-cve`** — parses changed lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`) and queries [OSV.dev](https://osv.dev) for known CVEs. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · GHSA-…_`.
- **`secrets`** — scans added lines in the diff for ~14 high-confidence credential patterns (AWS keys, GitHub PATs, Slack tokens, Stripe keys, Google API keys, npm tokens, PEM private keys). Matches are masked before posting.
- **`sast`** — fans out to the language-appropriate installed tools: ESLint, Ruff, Dart analyzer, actionlint, Knip, Semgrep, TypeScript (`tsc --noEmit`), and golangci-lint. Semgrep uses `--config=auto` and also loads `.vor/semgrep-rules/` when that configured path exists.
- **`debris`** — catches PR-added merge-conflict markers, debugger statements, focused tests, and stray debug logging.
- **`migration-safety`** — flags risky DDL in migration files, including destructive statements and adding `NOT NULL` columns without defaults.
- **`dependency-hygiene`** — reports lockfile drift, loose or unpinned dependency ranges, and non-registry dependency sources.

## Opt-in and reserved scanners

- **`coverage-delta`** — runs a detected Vitest, Jest, or pytest-cov workflow and flags uncovered PR-added lines. It is off by default because it can be slow and requires project test dependencies.
- **`image-ocr`** — OCRs committed images with bundled Tesseract assets and applies the secrets patterns to the extracted text. It is off by default because of its latency.
- **`container-cve`** — is registered in config but remains a v1 stub whose `applies()` method always returns false.

## Shared pipeline

The defaults live in [`src/config/defaults.ts`](../src/config/defaults.ts). `security.enabled` controls the complete scanner track; `security.scanners.<name>.enabled` and optional `min_severity` values control individual scanners. Findings can be suppressed through `.vor/security-ignore.yml`.

Scanners run alongside the LLM agent by default. Inline findings are validated, deduplicated, filtered by scanner and global severity floors, and passed through the shared per-file and global caps before posting in the PR review.

Binary `image-ocr` findings cannot be anchored to GitHub diff lines. After the scanner and global severity floors are applied, they bypass inline validation and the per-file and global comment caps and render in a dedicated review-summary section instead. An [architecture](architecture.md) invariant is that scanners handle deterministic checks while the LLM handles semantic judgment.
