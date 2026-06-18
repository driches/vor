# Local usage

The same orchestrator that powers the GitHub Action runs on your machine against your local git — so you can review changes before you push. Every local review runs in dry-run mode; nothing is posted to GitHub.

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your environment first.

Run history and dashboard assets live under `~/.vor/` (override with `VOR_HOME`).

## Install

Run without installing:

```sh
npx @driches/vor review
```

Install once for a shorter command:

```sh
npm i -g @driches/vor
vor review
```

## Review commands

```sh
# Review uncommitted changes (auto-detects working tree vs branch range)
vor review

# Review a branch against a base
vor review --range --base origin/main --head HEAD

# Machine-readable output
vor review --json
```

## Run history

```sh
vor runs list              # list past runs stored under ~/.vor/runs
vor runs show <id>         # show a specific run in full
```

## Config inspection

```sh
vor config show            # print the resolved .vor.yml for this directory
vor config validate        # validate .vor.yml and report any errors
```

## Dashboard

A small web UI for browsing run history and kicking off new reviews:

```sh
vor dashboard              # serves http://127.0.0.1:4310 (loopback only)
```

## MCP server

Expose Vor to agents (e.g. Claude Code) over stdio. Available tools: `review_local_changes`, `list_runs`, `get_run`, `get_config`.

```sh
claude mcp add vor -- npx -y @driches/vor mcp
```
