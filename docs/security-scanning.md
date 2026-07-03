# Security scanning

The security scanners run in parallel with the AI review and post their findings in the same single PR review, tagged with provenance so you can tell at a glance which tool surfaced each finding.

## Scope (v1)

### Dependency CVEs

Parses changed lockfiles and queries [OSV.dev](https://osv.dev) for known vulnerabilities. Supported ecosystems:

- **npm**: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- **PyPI**: `requirements.txt` — `==`-pinned lines only
- **Go**: `go.sum` — module code lines only (`/go.mod`-only entries are pruned indirect deps whose code never ships, so they're skipped)

Uses the OSV.dev `/v1/querybatch` and `/v1/vulns/{id}` endpoints. No auth, no account, no per-call cost. Findings appear inline on the lockfile line with the version pin, tagged `_via OSV · GHSA-…_`.

For self-hosted or air-gapped setups, point `security.scanners.dependency_cve.osv_endpoint` at a local mirror.

### Secrets

Scans **added lines** in the diff for high-confidence credential patterns. Pre-existing secrets in untouched code are out of scope for the current PR. Matches are masked before posting.

Detected patterns:
- AWS access keys (`AKIA…`)
- AWS secret keys (entropy-gated)
- GitHub classic PATs (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`)
- GitHub fine-grained PATs (`github_pat_`)
- Slack tokens (`xox[baprs]-`)
- Stripe live/restricted keys (`sk_live_`, `rk_live_`)
- Google API keys (`AIza…`)
- npm tokens (`npm_…`)
- Anthropic API keys (`sk-ant-…`)
- OpenAI API keys (`sk-…T3BlbkFJ…` — covers legacy, project, service-account, and admin formats)
- GitLab PATs (`glpat-…`)
- Hugging Face tokens (`hf_…`)
- SendGrid API keys (`SG.….…`)
- DigitalOcean tokens (`dop_v1_…`, `doo_v1_…`, `dor_v1_…`)
- PEM private key headers
- JSON Web Tokens (`eyJ…`-prefixed 3-segment shape)

To cast a wider net at the cost of false positives, enable `security.scanners.secrets.include_generic_entropy: true`.

Full list of pattern IDs in [`src/scanners/secrets-patterns.ts`](src/scanners/secrets-patterns.ts).

### SAST

Runs the repo's own linters against changed files at zero token cost. Each linter activates only when its binary is available in the checkout — silent on stacks it doesn't apply to.

| Linter | Stack |
|---|---|
| ESLint | JavaScript / TypeScript |
| `tsc` | TypeScript |
| knip | TypeScript (unused exports) |
| Ruff | Python |
| `dart analyze` | Dart |
| golangci-lint | Go |
| actionlint | GitHub Actions workflows |
| Semgrep | All — `--config=auto` plus any custom rules under `.vor/semgrep-rules/` |

Disable all SAST with `security.scanners.sast.enabled: false`.

### Image OCR (opt-in)

Off by default. When enabled (`security.scanners.image_ocr.enabled: true`), OCRs PNG/JPG/GIF/WEBP/BMP files added by the PR and runs the same credential patterns over the extracted text. Useful for catching keys visible inside screenshots of a terminal, `.env` file, or cloud console.

Because GitHub can't anchor inline comments on binary files, image-OCR findings appear in a dedicated "Security findings in binary files" section of the review summary.

### Container CVEs

Stub in v1 — not yet active. The `.vor.yml` slot is reserved so v2 can plug in without breaking your config.

## Suppressing findings — `.vor/security-ignore.yml`

Commit this file to your repo to suppress specific findings. All entry types support a required `reason` and an optional `expires` (`YYYY-MM-DD` or full RFC3339 timestamp). Expired entries still suppress the finding but emit a notice in the run log so you don't forget to revisit them.

```yaml
entries:
  # Suppress a specific GHSA across any package
  - ghsa_id: GHSA-xxxx-xxxx-xxxx
    reason: "Internal-only service, no external input"
    expires: 2026-12-31

  # Suppress a specific CVE
  - cve_id: CVE-2025-12345
    reason: "Patch shipped in v2.1.0"

  # Suppress by package + semver range
  - package:
      name: lodash
      ecosystem: npm           # npm | PyPI | Go
      version: ">=4.17.20 <4.18.0"
    reason: "Vendor pin until next major"

  # Suppress secrets in a specific file (e.g. test fixtures)
  - file: src/__fixtures__/aws-test-key.txt
    rule: "secret:aws-access-key-id"
    reason: "Synthetic test fixture, never deployed"
```

Supported `rule` values for `file` entries are `secret:<pattern-id>` for any pattern id in [`src/scanners/secrets-patterns.ts`](src/scanners/secrets-patterns.ts):
- `secret:aws-access-key-id`, `secret:aws-secret-access-key`
- `secret:github-pat-classic`, `secret:github-pat-oauth`, `secret:github-pat-user-server`, `secret:github-pat-server-server`, `secret:github-pat-refresh`, `secret:github-pat-fine-grained`
- `secret:slack-token`, `secret:stripe-live-key`, `secret:stripe-restricted-key`, `secret:google-api-key`, `secret:npm-access-token`
- `secret:anthropic-api-key`, `secret:openai-api-key`, `secret:gitlab-pat`, `secret:huggingface-token`, `secret:sendgrid-api-key`, `secret:digitalocean-token`
- `secret:private-key-pem`, `secret:jwt`, `secret:generic-high-entropy`

And for dependency CVEs: `osv:<id>` (e.g. `osv:GHSA-jf85-cpcp-j695`)

If the ignore file is missing, malformed, or fails schema validation, Vor degrades to "no suppressions" and logs a warning — a typo in the ignore file will never block your code review.
