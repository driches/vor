---
type: Service
title: Vor — AI PR Review GitHub Action
description: Vor is an AI-powered pull-request code review GitHub Action with parallel deterministic vulnerability scanning, running on Anthropic Claude or OpenAI.
tags: [github-action, code-review, llm, security]
timestamp: 2026-07-20T00:00:00Z
---

# Vor — AI PR Review GitHub Action

Vor (`@driches/vor`, v0.6.0, MIT, author Doug Riches) is a GitHub Action that reviews pull requests with an LLM and posts inline review comments with concrete code suggestions, anchored to real lines in the diff. In parallel it runs deterministic [scanners](scanners.md) that flag known CVEs in changed lockfiles and hardcoded secrets in the diff — all findings post in the same single PR review.

It is provider-agnostic: the same custom tool-use loop talks to Anthropic via `@anthropic-ai/sdk` and to OpenAI via the Responses API. The provider is inferred from the model id (`claude-*` → Anthropic; `gpt-*` / `o<digit>*` / `chatgpt-*` → OpenAI), so users supply only the API key for the provider they use.

## Usage

- Distributed as a GitHub Marketplace Action (`driches/vor@v0`, defined in `action.yml`); typically triggered on `pull_request` events and via `workflow_dispatch` with a `pr_number` input.
- Auto-trigger can be opted out with `allow_auto_trigger: 'false'`.
- Supports `dry_run` (log the review instead of posting comments).
- Also ships a CLI: `bin.vor` → `dist/cli.js`; there is a `local-review` script for running reviews locally.
- Requires Node >= 20. Docs site: https://driches.github.io/vor/

See [architecture](architecture.md) for how the review loop is structured and [tech-stack](tech-stack.md) for dependencies.
