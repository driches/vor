---
type: Service
title: Vor — AI PR Review for GitHub and Bitbucket Cloud
description: Vor is an AI-powered pull-request reviewer for GitHub Actions and Bitbucket Pipelines with parallel deterministic vulnerability scanning, running on Anthropic Claude or OpenAI.
tags: [github-action, bitbucket-pipelines, code-review, llm, security]
timestamp: 2026-08-28T00:00:00Z
---

# Vor — AI PR Review for GitHub and Bitbucket Cloud

Vor (`@driches/vor`, v0.6.0, MIT, author Doug Riches) reviews pull requests with an LLM and posts concrete findings anchored to real lines in the diff. GitHub runs post one native review; Bitbucket Cloud runs post a summary plus separate inline comments through Bitbucket Pipelines. In parallel Vor runs deterministic [scanners](scanners.md) that flag known CVEs, secrets, SAST output, and other pattern-backed findings through the same validation and filtering pipeline.

It is provider-agnostic: the same custom tool-use loop talks to Anthropic via `@anthropic-ai/sdk` and to OpenAI via the Responses API. The provider is inferred from the model id (`claude-*` → Anthropic; `gpt-*` / `o<digit>*` / `chatgpt-*` → OpenAI), so users supply only the API key for the provider they use.

## Usage

- Distributed as a GitHub Marketplace Action (`driches/vor@v0`, defined in `action.yml`); typically triggered on `pull_request` events and via `workflow_dispatch` with a `pr_number` input.
- The published CLI exposes `vor bitbucket review` for Bitbucket Cloud pull-request Pipelines. It reads Bitbucket's built-in workspace, repository, PR, and clone-directory variables and authenticates with a scoped API token.
- Auto-trigger can be opted out with `allow_auto_trigger: 'false'`.
- Both platforms support dry-run review output without PR comment, sticky-cleanup, approval, or change-request writes.
- Also ships a CLI: `bin.vor` → `dist/cli.js`; there is a `local-review` script for running reviews locally.
- Requires Node >= 20. Docs site: https://driches.github.io/vor/

See [architecture](architecture.md) for how the review loop is structured and [tech-stack](tech-stack.md) for dependencies.
