# Set up Vor on GitHub Actions

This guide configures automatic Vor reviews for pull requests in a GitHub repository. Vor uses the repository's built-in `GITHUB_TOKEN` to read the PR and post one GitHub review; you only need to add an LLM API key.

## Before you begin

You need:

- Admin access to the repository, or permission to manage Actions secrets and workflows.
- GitHub Actions enabled for the repository.
- An Anthropic API key or an OpenAI API key.
- A model that the selected provider has enabled for your account. GPT-5.6 is currently limited preview.

Do not create a GitHub personal access token for Vor. GitHub supplies a short-lived `GITHUB_TOKEN` to each workflow run, and the workflow below grants it only the permissions Vor needs.

## 1. Add the LLM API key

In the repository, open **Settings > Secrets and variables > Actions**, select **New repository secret**, and add one of these secrets:

| Provider | Secret name | Default model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-sol` |

Add only the provider key you plan to use. Never put the key directly in the workflow or `.vor.yml`. See [GitHub's Actions secrets guide](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui) for organization and environment secret options.

## 2. Add the workflow

Create `.github/workflows/vor.yml`:

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
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: driches/vor@v0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'claude-sonnet-4-6' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

`contents: read` lets Vor read repository context. `pull-requests: write` lets it create and supersede reviews. The action uses `${{ github.token }}` automatically, so no `github_token` input is needed in a normal workflow. GitHub documents this permission model in [Use `GITHUB_TOKEN` for authentication](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

### Use OpenAI instead

Change the workflow dispatch default and the action step:

```yaml
      model:
        description: 'Model to use'
        required: false
        default: 'gpt-5.6-sol'

# ...

      - uses: driches/vor@v0
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          provider: openai
          pr_number: ${{ inputs.pr_number }}
          model: ${{ inputs.model || 'gpt-5.6-sol' }}
          dry_run: ${{ inputs.dry_run || 'false' }}
```

The `provider` input is optional when the model starts with `gpt-`, but setting it explicitly makes the workflow's intent clear. If your account does not have GPT-5.6 preview access, set `model` to another OpenAI model your account supports.

## 3. Optionally add `.vor.yml`

The same `.vor.yml` works on GitHub and Bitbucket. A small starting configuration is:

```yaml
severity:
  floor: minor
  max_comments_per_file: 5
  max_comments_total: 30

exclude:
  paths:
    - "dist/**"
    - "**/__generated__/**"

review:
  event: COMMENT
  sticky: true
```

`COMMENT` is the non-blocking default. Set `event` to `REQUEST_CHANGES` or `APPROVE` only when that review state matches your repository policy. See the [full configuration reference](../docs/configuration.md).

## 4. Verify the installation

1. Open a pull request from a branch in the same repository.
2. Open **Actions > Vor** and confirm the workflow completed.
3. In the log, confirm Vor loaded the expected PR, model, provider, changed files, and `.vor.yml`.
4. Return to the PR and confirm the review summary appears. Inline comments appear only when Vor keeps findings after validation and filtering.
5. Push another commit or rerun the workflow. With `review.sticky: true`, the previous Vor review is superseded before the new one posts.

To test without writing to the PR, open **Actions > Vor > Run workflow**, enter the PR number, and set `dry_run` to `true`. Dry run executes the agent and scanners and can incur LLM usage, but it does not dismiss or post reviews.

## Trigger behavior

- `opened`, `synchronize`, `reopened`, and `ready_for_review` run automatically.
- `workflow_dispatch` reviews the PR number entered in the Actions UI.
- Draft PRs are skipped until they are marked ready for review.
- Fork PRs do not receive repository secrets on the normal `pull_request` event, so Vor exits with `skipped_no_key_<provider>` instead of spending an API key.
- Vor refuses `pull_request_target`, `pull_request_review`, and `pull_request_review_comment` events for safety and to prevent review loops.

For manual-only operation or a guarded `/review` PR comment workflow, see the [trigger options](../docs/triggers.md).

## Security and version pinning

- Keep the LLM key in an Actions secret and grant it only to repositories that should use it.
- Keep the workflow permissions at `contents: read` and `pull-requests: write`.
- Do not expose secrets to untrusted fork code through `pull_request_target`.
- `driches/vor@v0` follows the latest compatible v0 release. For strict supply-chain pinning, replace it with a full release commit SHA and update it deliberately.

## Troubleshooting

| Symptom | Check |
|---|---|
| `skipped_no_key_anthropic` or `skipped_no_key_openai` | Confirm the secret name, selected provider, model, and repository access policy for the secret. |
| `Resource not accessible by integration` | Confirm the workflow has `pull-requests: write` and repository or organization policy allows that permission. |
| Model-not-found or access error | Select a model enabled for the provider account. GPT-5.6 requires preview access while it remains limited. |
| Workflow does not start | Confirm Actions are enabled and the workflow contains the relevant `pull_request` activity type. Fork workflows may require maintainer approval. |
| Review has a summary but no inline comments | The run succeeded but no finding survived line validation, severity filtering, deduplication, and comment caps. |
| Manual run cannot find a PR | Enter the numeric PR number and run the workflow in the repository that owns the PR. |
