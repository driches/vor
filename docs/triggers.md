# Trigger options

## Default: auto-trigger on every PR

The standard setup triggers Vor automatically on every pull request event (`opened`, `synchronize`, `reopened`, `ready_for_review`). See the [Getting started](https://driches.github.io/vor/overview/#getting-started) guide for the minimal workflow file.

## Manual-only (no auto-trigger)

To run Vor on demand instead of on every push, remove `pull_request` from the trigger and set `allow_auto_trigger: 'false'`:

```yaml
name: Vor
on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number to review'
        required: true
      model:
        description: 'Model to use'
        required: false
        default: 'claude-sonnet-4-6'
      dry_run:
        description: 'Log review instead of posting comments'
        required: false
        default: 'false'
        type: boolean

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
          allow_auto_trigger: 'false'
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'claude-sonnet-4-6' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

Then trigger manually: **Actions → Vor → Run workflow → enter PR number**.

> `pull_request_target` is always blocked regardless of `allow_auto_trigger` — fork PRs run with base-repo secrets, so Vor never auto-runs on them.

## Comment trigger (`/review`)

Trigger from a comment on the PR itself instead of the Actions tab. Re-triggering is just typing `/review` on the PR again — no navigation required.

```yaml
name: Vor (comment)
on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  # Two gates: who may trigger (author_association), and whether the PR's code
  # is safe to run. Vor's SAST scanners run your repo's own linters from the
  # checkout (e.g. node_modules/.bin/eslint — on by default), so checking out
  # a fork PR's HEAD with secrets in scope would execute attacker-controlled
  # code on the runner. The guard skips forks; same-repo branches with write
  # access are trusted.
  guard:
    if: >
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '/review') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    outputs:
      same_repo: ${{ steps.head.outputs.same_repo }}
    steps:
      - id: head
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.issue.number }}
        run: |
          head="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.repo.full_name')"
          if [ "$head" = "$REPO" ]; then
            echo "same_repo=true" >> "$GITHUB_OUTPUT"
          else
            echo "same_repo=false" >> "$GITHUB_OUTPUT"
          fi

  review:
    needs: guard
    if: needs.guard.outputs.same_repo == 'true'
    runs-on: ubuntu-latest
    steps:
      # Safe to check out PR HEAD: the guard confirmed it's a same-repo (trusted)
      # branch. grep_repo_at_ref and the SAST linters run against this checkout.
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.issue.number }}/head
          fetch-depth: 0
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ github.event.issue.number }}
```

Anyone with write access types `/review` on a PR **from a branch in your repo** to start or refresh a review against current HEAD. Swap `/review` for `@vor` in the comment body check if you prefer — no bot account required.

### Security — why the fork guard

`issue_comment` runs in your base repo with secrets and a write token in scope. Vor's SAST scanners run your repo's own linters resolved from the checkout — e.g. `node_modules/.bin/eslint` — so pointing this at a **fork** PR's HEAD would execute attacker-controlled code on the runner (a "pwn request"). The guard ensures the review only runs when the PR head is in your own repo.

`author_association` gates *who can trigger*, not whether the code is safe.

### Reviewing external fork PRs

To review a fork PR without exposing secrets to fork code: use a `workflow_dispatch` that checks out a trusted ref and reviews the fork PR by number (Vor reads its diff over the API). Pin the action to a release tag or commit SHA.
