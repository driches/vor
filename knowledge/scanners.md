---
type: Concept
title: Deterministic Scanners and Finding Pipeline
description: Two deterministic scanners (dependency-cve via OSV.dev, secrets pattern matching) run in parallel with the AI review and share its severity/cap pipeline.
tags: [security, scanners, cve, secrets, osv]
timestamp: 2026-07-20T00:00:00Z
---

# Deterministic Scanners and Finding Pipeline

Two deterministic scanners run in parallel with the AI review (code in `src/scanners`):

- **`dependency-cve`** — parses changed lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`) and queries [OSV.dev](https://osv.dev) for known CVEs. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · GHSA-…_`.
- **`secrets`** — scans added lines in the diff for ~14 high-confidence credential patterns (AWS keys, GitHub PATs, Slack tokens, Stripe keys, Google API keys, npm tokens, PEM private keys). Matches are masked before posting.

## Shared pipeline

Scanner findings flow through the same **severity floor / per-file cap / global cap** pipeline as AI comments, and everything posts in one single PR review. An [architecture](architecture.md) invariant: scanners are deterministic, in contrast to the LLM review.

Suppression appears to be configurable via `.vor/security-ignore.yml`, and `.vor/semgrep-rules` exists in the repo.

## Open questions

- Exact semantics of severity floor and the cap values, and how they're configured.
- Whether semgrep rules feed a third scanner or are used elsewhere.
