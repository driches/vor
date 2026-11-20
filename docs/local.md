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
vor config validate        # validate .vor.yml (and referenced architecture file)
```

## Architecture checks

Enforce configured architecture standards across the entire repository with zero LLM calls (no API key required):

```sh
vor arch check             # check repo against .vor.yml / .vor/architecture.yml
vor arch check --preset hexagonal --root src   # ad-hoc preset check
vor arch check --update-baseline               # snapshot pre-existing violations
vor arch explain src/domain/order.ts           # inspect layer/context & imports for one file
vor arch init --preset hexagonal --write       # generate starter .vor/architecture.yml
vor arch presets                               # list built-in presets
```

## Reference documentation cache

Sync, inspect, and manage cached reference docs and engineering standards:

```sh
vor refs sync              # load configured reference sources into disk cache
vor refs sync --refresh    # force-revalidate / re-fetch remote sources
vor refs status            # show cached entries, age, TTL, and ETag state
vor refs show <id>         # print normalized text for one reference doc
vor refs clear             # clear cached reference entries
```

These commands do not require an API key and do not make provider requests.
`config show` includes any explicitly unsafe provider override in the resolved
output, and both commands warn when one is present.

## Dashboard

A small web UI for browsing run history and kicking off new reviews:

```sh
vor dashboard              # serves http://127.0.0.1:4310 (loopback only)
```

## MCP server

Expose Vor to agents (e.g. Claude Code) over stdio. Available tools: `review_local_changes`, `list_runs`, `get_run`, `get_config`, `check_architecture`, `list_references`, `read_reference`.

```sh
claude mcp add vor -- npx -y @driches/vor mcp
```
