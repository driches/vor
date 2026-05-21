# Security Policy

Thanks for helping keep this project and its users safe.

## Supported versions

| Version | Supported |
|---|---|
| `v0.x` (current) | ✅ |
| `< v0.1` | ❌ |

Once `v1.0.0` ships, the previous major will receive security fixes for six months.

## Reporting a vulnerability

**Please do not open a public issue.**

The preferred channel is **[GitHub Security Advisories](https://github.com/driches/code-review/security/advisories/new)** — this lets us collaborate on a fix privately and coordinate disclosure.

If that's not workable, email **doug@richesfamily.ca**. PGP key available on request.

### What to include

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept if you have one.
- The version of the action and (if relevant) the Claude model used.
- Whether the issue is already public somewhere.

### What's in scope

This action runs inside `actions/runner` with access to:
- `ANTHROPIC_API_KEY` (passed via `inputs.anthropic_api_key`)
- `GITHUB_TOKEN` (defaults to the workflow token with `pull-requests: write`)
- The full PR diff and any files the agent reads via `read_file_at_ref` / `read_repo_context_file`

Anything that could leak those secrets, escalate the token's permissions, exfiltrate repo contents to an unintended destination, or cause the agent to perform a destructive action on the repo is in scope. So is anything that could trick the agent into executing untrusted PR content as instructions (prompt injection via diff or context files) in a way that causes one of the above.

### What's out of scope

- Issues in `@anthropic-ai/sdk`, `@octokit/*`, or other dependencies — please report those upstream. We'll bump versions promptly once a fix is released.
- Issues that require an attacker to already have write access to the repo running the action.
- Review-quality issues (the agent missed something, or flagged something wrong) — those belong in the [review-quality template](https://github.com/driches/code-review/issues/new?template=review_quality.yml).

## Response

Best effort:
- **Acknowledgment** within 5 business days.
- **Initial assessment** within 10 business days.
- **Fix or mitigation timeline** communicated after assessment.

We'll credit reporters in the changelog and advisory unless they prefer to remain anonymous.
