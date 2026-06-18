# Vor

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Vor" width="420">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/driches/vor/actions/workflows/ci.yml"><img src="https://github.com/driches/vor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/driches/vor/releases"><img src="https://img.shields.io/github/v/release/driches/vor?include_prereleases&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/driches/vor" alt="MIT License"></a>
  <a href="https://github.com/marketplace/actions/vor"><img src="https://img.shields.io/badge/Marketplace-GitHub%20Action-2088FF?logo=github" alt="GitHub Marketplace"></a>
  <a href="https://github.com/driches/vor/discussions"><img src="https://img.shields.io/github/discussions/driches/vor" alt="Discussions"></a>
</p>

<p align="center">
  <strong><a href="https://driches.github.io/vor/">Documentation &amp; site →</a></strong>
</p>

> AI code review that posts inline comments anchored to real diff lines — with one-click suggestions, CVE scanning, and secrets detection — running entirely inside your CI on the LLM you already pay for.

## Why Vor

**No third-party code-review vendor sees your code.** The diff and any context the agent reads go directly to the LLM provider you configure — the same Anthropic or OpenAI account you already pay for. No separate SaaS, no per-seat subscription. Cost is metered per run via the `cost_usd` output.

**Comments can't land on lines that don't exist.** Every inline comment is validated against the actual diff before posting. The agent gets a structured hint and self-corrects — hallucinated line numbers are structurally impossible.

**Security is first-class, not a bolt-on.** CVE scanning via OSV, 14+ hardcoded-credential patterns, and multi-language SAST run in parallel with the AI review and post in the same single PR review.

**Works with Claude or GPT.** Switch by changing one line — the provider is inferred from the model ID.

## Getting started

### 1. Add your API key as a repo secret

Go to **Settings → Secrets and variables → Actions** and add `ANTHROPIC_API_KEY`. For OpenAI models, add `OPENAI_API_KEY` instead.

### 2. Add the workflow file

Create `.github/workflows/vor.yml` in your repo:

```yaml
name: Vor
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
```

Prefer OpenAI? Replace `anthropic_api_key` with `openai_api_key` and add `model: gpt-4.1`. The provider is inferred from the model name.

### 3. Open a PR

Vor reviews it automatically. To re-run on any existing PR, go to **Actions → Vor → Run workflow** and enter the PR number.

> Want to trigger from a PR comment, or limit to manual runs only? See [Trigger options →](https://driches.github.io/vor/triggers/).

## What a review looks like

Every review has:

- **Inline comments** anchored to specific lines — not a wall of text at the bottom
- **Severity tags** — `[CRITICAL · bug]`, `[IMPORTANT · security]`, `[MINOR · readability]`
- **Concrete suggestions** in ` ```suggestion ``` ` blocks (one-click apply in GitHub) for critical and important findings
- **A "why it matters" sentence** — user impact or maintainability cost, not just "this is wrong"
- **A summary** with 1–5 strengths, an overall assessment (Approve / Comment / Request changes), and reasoning
- **Security findings** tagged `_via OSV · GHSA-…_` or `_via secrets scan_`, alongside the AI findings in the same review

By default, all reviews are posted as `COMMENT` — Vor never auto-blocks. To opt into `REQUEST_CHANGES` on critical findings, see [Configuration →](https://driches.github.io/vor/configuration/).

## Local usage

The same orchestrator runs against your local git — review changes before you push. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` first.

```sh
npx @driches/vor review                              # review uncommitted changes

# review a branch against main
npx @driches/vor review --range --base origin/main --head HEAD

vor dashboard                                   # run history at http://127.0.0.1:4310
claude mcp add vor -- npx -y @driches/vor mcp  # expose to Claude Code as MCP
```

See [Local usage →](https://driches.github.io/vor/local/) for the full CLI reference.

## Configuration

Drop a `.vor.yml` in your repo root to control the model, focus areas, severity floor, file exclusions, per-run token budget, and more.

→ [Full configuration reference](https://driches.github.io/vor/configuration/)

## Security scanning

Three scanners run in parallel with the AI review:

- **Dependency CVEs** — queries [OSV.dev](https://osv.dev) for known vulnerabilities in changed lockfiles (npm, PyPI)
- **Secrets** — scans added lines for hardcoded credentials: AWS keys, GitHub PATs, Stripe keys, and more
- **SAST** — runs your repo's own linters (ESLint, Ruff, golangci-lint, Semgrep, and others) at zero token cost

→ [Security scanning docs](https://driches.github.io/vor/security-scanning/)

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the dogfood workflow, and the release process. Good first contributions are tagged [`good first issue`](https://github.com/driches/vor/labels/good%20first%20issue). By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Support

- **Questions, ideas, show-and-tell** → [GitHub Discussions](https://github.com/driches/vor/discussions)
- **Bugs and feature requests** → [Open an issue](https://github.com/driches/vor/issues/new/choose)
- **Security vulnerabilities** → [GitHub Security Advisories](https://github.com/driches/vor/security/advisories/new) — please don't file public issues for vulnerabilities

See [SUPPORT.md](SUPPORT.md) for more.

## License

MIT
