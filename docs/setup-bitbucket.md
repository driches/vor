# Set up Vor on Bitbucket Pipelines

This guide configures automatic Vor reviews for pull requests in Bitbucket Cloud. Bitbucket Data Center and Bitbucket Server are not supported in v1.

## Before you begin

You need:

- Admin access to the Bitbucket Cloud repository.
- Pipelines enabled for the repository.
- An Atlassian account with access to the repository and permission to comment on pull requests.
- A scoped Bitbucket API token for that account.
- An Anthropic API key or an OpenAI API key.
- Pull requests opened from branches in the same repository. Bitbucket Cloud does not start pull-request Pipelines for fork PRs.

A dedicated automation account is recommended. The token acts as its owner, so comments, approvals, and change requests appear from that account. Bitbucket may prevent an account from approving its own pull request; Vor still posts comments when a review-state update is not allowed.

## 1. Create a scoped Bitbucket API token

Follow Atlassian's [Create an API token](https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/) flow:

1. Open the Atlassian account **Security** page.
2. Select **Create and manage API tokens**.
3. Select **Create API token with scopes**.
4. Choose **Bitbucket** as the application.
5. Select all three permissions below.
6. Copy the token when it is shown. Atlassian does not show it again.

| Permission in the token UI | API scope | Why Vor needs it |
|---|---|---|
| Repositories: Read | `read:repository:bitbucket` | Read source files at the PR commits. |
| Pull requests: Read | `read:pullrequest:bitbucket` | Read PR metadata, diffs, diffstat, and prior comments. |
| Pull requests: Write | `write:pullrequest:bitbucket` | Post and resolve comments, approve, or request changes. |

The token owner must also have access to the target repository. See Atlassian's [API token permission reference](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/).

## 2. Add secured Pipeline variables

Open **Repository settings > Pipelines > Repository variables** and add:

| Variable | Required | Secured | Value |
|---|---|---|---|
| `BITBUCKET_API_EMAIL` | yes | recommended | Atlassian account email belonging to the API token owner. This is not the Bitbucket username. |
| `BITBUCKET_API_TOKEN` | yes | yes | Scoped API token created in step 1. |
| `ANTHROPIC_API_KEY` | one LLM key | yes | Anthropic API key. |
| `OPENAI_API_KEY` | one LLM key | yes | OpenAI API key. OpenAI-only runs default to `gpt-5.6-sol`. |

Add either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, not both, unless `.vor.yml` or `--provider` explicitly selects the provider. Mark secret values as **Secured** so Bitbucket masks them in logs. Workspace variables also work, but they make the credentials available to more repositories; prefer repository variables unless sharing is intentional. See Atlassian's [variables and secrets guide](https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/).

Do not create these built-in variables yourself. Bitbucket supplies them to pull-request Pipelines:

- `BITBUCKET_WORKSPACE`
- `BITBUCKET_REPO_SLUG`
- `BITBUCKET_PR_ID`
- `BITBUCKET_CLONE_DIR`
- `BITBUCKET_COMMIT`

## 3. Add `bitbucket-pipelines.yml`

Create `bitbucket-pipelines.yml` at the repository root:

```yaml
image: node:20

pipelines:
  pull-requests:
    '**':
      - step:
          name: Vor review
          clone:
            depth: full
          script:
            - git checkout "$BITBUCKET_COMMIT"
            - npx -y @driches/vor@latest bitbucket review
```

If the repository already has Pipelines configuration, merge the `pull-requests` entry into its existing top-level `pipelines` block. A Pipelines file can contain only one top-level `pipelines` property.

Why each line matters:

- `node:20` satisfies Vor's Node.js 20 or newer runtime requirement.
- `depth: full` gives disk-backed scanners and repository search the history they need.
- Bitbucket prepares a PR Pipeline by merging the destination branch into the working tree. `git checkout "$BITBUCKET_COMMIT"` returns the checkout to the source commit so disk-backed scanners inspect the same source change represented by the PR API diff.
- `npx -y` downloads and runs the published Vor CLI without a repository dependency. For reproducible builds, replace `latest` with an exact released version after validating it.

## 4. Optionally add `.vor.yml`

GitHub and Bitbucket use the same configuration. A small starting configuration is:

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

Review state mapping:

| `.vor.yml` event | Bitbucket behavior |
|---|---|
| `COMMENT` | Post the summary and inline comments without changing PR approval state. |
| `REQUEST_CHANGES` | Post comments, then request changes through the Bitbucket PR API. |
| `APPROVE` | Post comments, then approve through the Bitbucket PR API. |

Approval and change-request updates are best effort. If Bitbucket policy rejects the state update, Vor logs a warning and preserves the posted comments. See the [full configuration reference](../docs/configuration.md).

## 5. Verify the installation

1. Open a pull request from a branch in the same repository.
2. Open **Pipelines** and confirm the **Vor review** step completed.
3. In the log, confirm Vor loaded the expected workspace, repository, PR, model, provider, changed files, and `.vor.yml`.
4. Return to the PR. Confirm one summary comment appears and that findings appear as separate inline comments on changed lines.
5. Rerun the Pipeline on the same PR. With `review.sticky: true`, old unresolved Vor inline threads should be resolved before the new comments post.
6. Temporarily append `--dry-run` to the command and rerun it. The log should render the review, while the PR receives no new comments and existing threads are not resolved.

Dry run still executes the agent and scanners and can incur LLM usage. It disables Bitbucket write operations, not the model call.

## CLI inputs and overrides

The normal PR Pipeline needs no flags because Bitbucket supplies the PR context. These overrides are available for custom Pipelines and testing:

| Flag | Environment default | Purpose |
|---|---|---|
| `--workspace` | `BITBUCKET_WORKSPACE` | Workspace slug. |
| `--repo` | `BITBUCKET_REPO_SLUG` | Repository slug. |
| `--pr` | `BITBUCKET_PR_ID` | Positive numeric pull request ID. |
| `--config` | `.vor.yml` | Repository-relative config path. |
| `--model` | `.vor.yml` or provider default | Model override for this run. |
| `--provider` | inferred | `anthropic` or `openai`. |
| `--dry-run` | off | Run without resolving or posting comments. |
| `--api-base-url` | `https://api.bitbucket.org/2.0` | Alternate API endpoint for controlled testing. |

Authentication always comes from `BITBUCKET_API_EMAIL` and `BITBUCKET_API_TOKEN`. LLM authentication comes from `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Platform behavior to expect

- Vor posts one global summary comment and one inline Bitbucket comment per kept finding.
- GitHub-style suggestion blocks are rendered as Markdown; Bitbucket does not provide the same one-click suggestion behavior.
- Sticky mode resolves prior unresolved Vor inline threads. Historical summary comments remain as the run record.
- Pull-request Pipelines run when a same-repository PR is created or its source branch is updated.
- Fork PRs do not trigger Bitbucket pull-request Pipelines.

## Security and token maintenance

- Use a single-purpose API token with only the three documented scopes.
- Prefer a dedicated automation account so review state is not tied to a developer account.
- Store the token and LLM key only as secured Pipeline variables. Do not echo them or place them in YAML.
- Prefer repository variables over workspace variables unless every repository should receive the credentials.
- Give the token an expiry date and rotate it before expiry or immediately after suspected exposure.

## Troubleshooting

| Symptom | Check |
|---|---|
| `BITBUCKET_API_EMAIL and BITBUCKET_API_TOKEN are required` | Confirm both repository variables exist, are spelled exactly, and are available to the Pipeline. |
| Bitbucket API returns `401` | Use the Atlassian account email associated with the token, confirm the token value, and check that it has not expired. |
| Bitbucket API returns `403` | Confirm all three token scopes and verify the token owner can access and comment on the repository's PRs. |
| Pipeline does not start for a PR | Confirm Pipelines are enabled, the YAML has the `pull-requests` selector, and the PR is not from a fork. |
| Model-not-found or access error | Select a model enabled for the provider account. GPT-5.6 requires preview access while it remains limited. |
| Summary posts but approval/change request does not | Confirm the token owner may perform that action and is not trying to approve its own PR. The state update is best effort. |
| Review has no inline comments | The run succeeded but no finding survived line validation, severity filtering, deduplication, and comment caps. |
| `vor` cannot start | Confirm the Pipeline image provides Node.js 20 or newer and that npm registry access is allowed. |
