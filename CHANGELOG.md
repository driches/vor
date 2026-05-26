# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — `worker_summarize_file` Haiku tool (behind `worker_delegation` flag)
- **Second worker tool** for Sonnet to delegate to: [src/tools/worker-summarize-file.ts](src/tools/worker-summarize-file.ts). Sonnet calls `worker_summarize_file(path, focus_question)` for orientation/triage reads — "what does this file do?" or "how does X work?" — instead of `read_file_at_ref`. Haiku reads the file inside the tool handler, returns a structured summary (3-line file purpose + direct answer to the focus question + up to 5 line-specific flags worth deeper investigation). Sonnet's conversation only carries the summary, not the raw 500-line file content that would otherwise sit in the cache pool for every subsequent turn.
- **Verification invariant preserved.** The tool deliberately does NOT call `recordHeadRead`, so worker summaries do NOT satisfy the read-before-post validator. For critical/important findings, Sonnet must still call `read_file_at_ref` itself on the target range — the validator (and a unit test in [src/tools/worker-summarize-file.test.ts](src/tools/worker-summarize-file.test.ts)) pin this. Worker output is a hint, not evidence.
- **Cost mechanism.** A typical 500-line file read places ~5K input tokens in the conversation that re-bills at the cache-read rate for every subsequent turn (~75K cache-read tokens over a 15-turn loop). Replacing 3-5 such reads per PR with one-shot Haiku summaries trades a small Haiku spend (~$0.005-0.01 per call) for a sizable Sonnet cache-pool cut. Eval data forthcoming.
- **Opt-in via the existing flag.** Surfaces only when `experimental.worker_delegation.enabled: true` in `.code-review.yml`, alongside the existing `worker_check_usage_claim` tool. Default OFF.

## [0.4.0] - 2026-05-26

### Added — Static-first hybrid analysis (multi-language SAST)
- **Linter fan-out under the `sast` scanner slot.** A new orchestrator in [src/scanners/sast.ts](src/scanners/sast.ts) runs per-language linter modules in parallel and concatenates their findings. The intent is to push deterministic findings (type errors, unused imports, framework anti-patterns, config typos) out of Sonnet's tool loop and onto the free-and-instant scanner path, so per-finding cost approaches $0 for everything a linter can express. Sonnet's budget is reserved for semantic and design judgment that no linter expresses.
- **Per-language modules**, each a `LinterModule` registered with the orchestrator:
  - [src/scanners/sast/eslint.ts](src/scanners/sast/eslint.ts) — TypeScript/JavaScript via the repo's own ESLint config (requires `node_modules/.bin/eslint` in the workspace).
  - [src/scanners/sast/ruff.ts](src/scanners/sast/ruff.ts) — Python via ruff (resolves `<workspace>/.venv/bin/ruff` → PATH).
  - [src/scanners/sast/dart.ts](src/scanners/sast/dart.ts) — Dart/Flutter via `dart analyze --format=machine` (Flutter SDK on PATH).
  - [src/scanners/sast/actionlint.ts](src/scanners/sast/actionlint.ts) — GitHub Actions workflow YAML via `actionlint -format '{{json .}}'` (binary on PATH).
  - [src/scanners/sast/knip.ts](src/scanners/sast/knip.ts) — TS/JS unused exports, types, and duplicates via the TS compiler's symbol table. Covers the "is X unused?" pattern that previously cost Sonnet 3-5 verification turns per finding.
  - [src/scanners/sast/semgrep.ts](src/scanners/sast/semgrep.ts) — multi-language pattern matching via Semgrep's auto-detected rulesets. Covers security anti-patterns, N+1 loops, common code smells across 20+ languages (TS/JS, Python, Go, Rust, Ruby, Java, C/C++, etc.). Single binary install via `pip install semgrep` or `brew install semgrep`.
- **`sast.enabled: true` by default.** [src/config/defaults.ts](src/config/defaults.ts). Opt out via `security.scanners.sast.enabled: false`. Each linter quietly no-ops when its binary isn't available, so adoption is zero-config for repos that already have the tools in their CI workflow.
- **Findings are restricted to lines the PR actually added** (per-file `added_lines` set). Pre-existing violations on context lines pre-date the PR and would be noise.
- **Failure isolation.** A misbehaving linter (parse error, runtime crash) surfaces as a non-fatal `ScanError` and the other linters still run. The sast scanner itself MUST NOT throw — contract identical to existing OSV and secrets scanners.

### Why this matters
v0.3.0 measured ~$1.99 per 3-case golden eval at 7/7 recall, with ~80% of Sonnet's turns spent on tool calls that deterministic tools could have answered for free. The v0.4.0 architectural shift is: scanners handle anything a linter can express; Sonnet handles only what requires natural-language reasoning. The eval harness uses `runAgent` directly and doesn't exercise scanners, so the cost win must be measured in production — see the PR description for the measurement plan.

### Notes for operators
- **Bring your own linter binaries.** Linters resolve from the workspace (eslint via `node_modules`, ruff via `.venv`, dart/actionlint via PATH). If your CI doesn't install these before the code-review step, the corresponding linter is a no-op. Future versions may bundle binaries.
- **Language coverage is intentionally incremental.** v0.4.0 ships 4 languages. Planned next: Go (`go vet` / `golangci-lint`), Rust (`clippy`), Shell (`shellcheck`), Ruby (`rubocop`).

## [0.3.0] - 2026-05-25

### Added
- **Pre-flight Haiku skim + on-demand worker tool (experimental, default off).** When `experimental.worker_delegation.enabled: true` is set in `.code-review.yml`, the agent loop now runs a Haiku 4.5 pre-flight call BEFORE Sonnet's tool loop. The pre-flight summarizes the diff into a structured candidate list (file, line range, severity guess, what/why) plus a per-file annotation of every changed file, and injects that into Sonnet's first user prompt. Sonnet starts with focused candidates instead of needing to wide-scan the full diff via `get_pr_diff` (which would otherwise sit in the message-history cache pool for every subsequent turn). The 100KB-of-cached-diff pattern was the single biggest contributor to per-turn cost in prior versions.
- **Worker tool (`worker_check_usage_claim`).** Optional mid-loop delegation: Sonnet can call this tool to offload a usage-claim verification (`unused` / `single_caller` / `pattern_violation`) to Haiku. The worker pre-fetches grep + a match-centered file window, hands them to Haiku, and returns a structured verdict with confidence. Sonnet treats output as a HINT, not as evidence.
- **Validator-enforced read-before-post discipline.** When delegation is enabled, `post_inline_comment` rejects critical/important findings unless Sonnet has called `read_file_at_ref` on the target line range earlier in the same run. Worker output and pre-flight output do NOT count as reads. This is the "and it will check the work" half of the design — it lets us trust delegated output for exploration without trusting it for final judgment. See [src/agent/validate-comment.ts](src/agent/validate-comment.ts) and [src/agent/run-context.ts](src/agent/run-context.ts).
- **Per-model cost tracking.** `Budget` now tracks token usage per model, and `RunAgentResult.perModelCost` exposes the Sonnet/Haiku split. Golden-eval runs persist `per_model_cost` in the run JSON (snake_case shape matching the typed `RunRecord` contract) so cost-vs-recall comparisons across delegation modes can be measured directly. `costFromUsage(model, usage)` in [src/util/pricing.ts](src/util/pricing.ts) is the single source of truth for cost calculation (production runner + eval harness consume it).
- **`--worker-delegation` flag in `npm run golden:eval`** to A/B test the experimental delegation on the captured cases.

### Measured impact (3-case golden eval, 7 Codex findings)

| Mode | Recall | Cost | Notes |
|---|---|---|---|
| Flag OFF (default) | 5/7 = 71% | $1.82 | Matches v0.2.2 baseline exactly. Zero regression for opt-out path. |
| **Flag ON** | **7/7 = 100%** | **$1.99** (+9%) | **All Codex findings recovered.** orbitboard cases hit 100% per-case agreement. |

Pre-flight cost itself is ~$0.07 across the 3 cases. The 7/7 recall is a +29-percentage-point improvement over v0.2.2 baseline (5/7) at +9% cost — roughly $0.08 per additional finding recovered. The bias risk the design called out ("Haiku biases Sonnet toward the candidate list") was mitigated by rendering EVERY changed file in the pre-flight section (annotated `N candidate(s)` or `no candidates`) so Sonnet can't silently drop unflagged files; an earlier iteration that alarmed-up the framing of unflagged files caused over-investigation (40-turn cap), and softening it landed on the current cost/recall trade.

### Operator notes
- **Flag OFF is unchanged.** Zero behavior change, zero risk. Verified by an eval run that matched v0.2.2 baseline exactly.
- **Flag ON is opt-in per repo.** Set `experimental.worker_delegation.enabled: true` in `.code-review.yml`. Default worker model is `claude-haiku-4-5`; override with `experimental.worker_delegation.worker_model`.
- **Iteration history** lived in the PR description for transparency: 5 measured iterations went from v0.3.0's initial 4/7 recall + $2.03 cost to the current 7/7 + $1.99 by deleting the system-prompt addition, adding a pre-flight Haiku pass, and tuning the file-list framing.

### Known follow-ups (not in this release)
- Cost reduction below baseline: a future iteration will likely cap `get_pr_diff` more aggressively when pre-flight is enabled, since the candidate list already covers the diff. Target is bringing cost from $1.99 down toward $1.50 while holding recall.
- Additional worker tools (`worker_summarize_file_purpose`, `worker_classify_files`) are designed but not in v0.3.0 — they'll ship after we see real-world telemetry on how often Sonnet invokes the existing worker tool.

### Fixed (Codex review feedback addressed in-PR)
- `runPreflight` BudgetError now caught inside runAgent's outer try (was escaping as orchestrator-level failure).
- `runGitGrep` in worker tool rejects on timeout / non-zero exit codes instead of silently returning `[]` (was producing false `unused: confirmed` verdicts on grep failures).
- Worker tool file-read window is now centered on the FIRST match line for each file (was always reading lines 1-200, missing matches deeper in files).
- `Budget.addUsage` checks caps BEFORE mutating state (was leaving partial state on `BudgetError`, a future retry would double-count).
- `per_model_cost` written to run JSON now uses snake_case to match the declared `RunRecord` contract.
- Removed nonsensical conditional type `Anthropic.MessageParam extends never ? never : ...` on `WorkerResult.usage`.
- Validator read-before-post check now validates BOTH `start_line` and `line` for multi-line range comments (was only checking `line`, letting a 190-line range claim pass with 1 line of verification).

## [0.2.2] - 2026-05-25

### Changed
- **Bumped Anthropic API `temperature` from `0.1` → `0.5`** ([src/agent/runner.ts](src/agent/runner.ts)). The 0.1 setting shipped in v0.2.1 regressed recall on the golden-eval dataset: matches dropped from 5/7 (71%) at the SDK default (1.0) to 3/7 (43%) at 0.1. One case (`orbitboard-pr-221`) went from 1 match → 0 matches (the agent reasoned itself out of flagging a real issue on an `actions/checkout@v5` mismatch), and one case (`code-review-pr-6`) hit the 40-turn budget cap mid-investigation (it had completed in 31 turns at the SDK default). 0.5 restored full 5/7 recall with no turn-cap blowouts and ~flat cost ($1.87 vs $1.82 baseline, +3%). The variance-reduction intent of v0.2.1 stands; the value was wrong.

## [0.2.1] - 2026-05-25

### Changed
- **Set Anthropic API `temperature: 0.1`** ([src/agent/runner.ts](src/agent/runner.ts)). Previously the agent loop used the SDK default (1.0), which sampled wide enough that two back-to-back runs on the same PR head could surface entirely different findings — production smoke testing on `orbitboard#226` between v0.1.2 and v0.2.0 saw an `IMPORTANT` base64-bypass finding flagged on one run and missed entirely on the next, despite the same model and same diff. 0.1 keeps the model decisive (still allowing rare token tie-breaks) without dropping to fully greedy sampling. No effect on per-request token cost.

## [0.2.0] - 2026-05-25

### Changed
- **Token cost reductions** (golden-eval-validated: ~70% reduction with zero recall regression):
  - **Prompt caching on tools + message-history prefix.** The agent loop now sets `cache_control: ephemeral` on the last tool definition (tools don't change across turns) and maintains breakpoints on the two most recent user messages, sliding them forward each turn. Two message breakpoints (system + last-tool + 2 messages = 4, the API's per-request limit) give the cache lookup a fallback anchor on high-fanout turns where Anthropic's bounded-backtrack from a single breakpoint could otherwise miss the previous boundary. The growing conversation prefix now reads from cache at the cache_read rate instead of being re-billed at the full input rate every turn. Zero behavior change — only billing changes.
  - **`cost_usd` is now model-aware** ([src/util/pricing.ts](src/util/pricing.ts)). Previously the runner hardcoded Sonnet rates, so action output and any downstream budget alerts would be wildly off when operators override the model. Pricing lives in a single shared module consumed by the production runner and the eval harness.

### Attempted but reverted (documented for posterity)

- **Default model swap to `claude-haiku-4-5`.** Reverted after golden-eval comparison on 3 captured PRs showed Haiku at 28.6% recall on critical+important findings vs Sonnet's 71.4% — Haiku posted ZERO findings on both `orbitboard-pr-213-jwt-auth` and `orbitboard-pr-221` despite Codex flagging 4 important issues across them. Haiku remains opt-in via `model:` in `.code-review.yml` for repos where the cost/recall tradeoff is acceptable.
- **Default `max_turns` lowered to 15.** Reverted after the first dogfood self-review hit `budget_exceeded` mid-investigation at the 15-turn cap. With caching dominant, the turn cap is the wrong cost lever.

### Fixed
- Review body when the agent skips `post_summary`: instead of falling back to a placeholder ("_Code review completed by … but no summary was produced._"), the formatter now synthesizes a real body from the inline findings — severity header, findings counts, truncated-comments line, and footer. When the run ended in anything other than `summary_posted` (turn limit, budget exhausted, abort, error), a prominent blockquote warning is emitted right after the severity header naming the termination reason, so a truncated run with zero findings can't be mistaken for a clean "No findings" review. The missing-`post_summary` call is also logged at warn-level in the orchestrator.

### Added
- Initial scaffold of the `driches/code-review` GitHub Action.
- Project logo (`assets/logo.svg`, `assets/logo-dark.svg`, `assets/icon.svg`) — "eye + diff lines" mark in deep purple.
- README header: logo block (with dark-mode variant via `<picture>`) and badges row (CI, latest release, license, marketplace, discussions).
- README sections: `## Contributing`, `## Support`, `## Security`.
- Governance files: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (vuln reporting policy, in-scope/out-of-scope, response SLA), `SUPPORT.md` (routing for questions, bugs, security, contributions).
- `.github/ISSUE_TEMPLATE/`: form-based templates for bug reports, feature requests, and **review-quality feedback** (project-specific, feeds prompt tuning). Blank issues disabled; contact links route to Discussions and Security Advisories.
- `.github/PULL_REQUEST_TEMPLATE.md` with checklist (typecheck, test, build, verify-dist, changelog, dogfood awareness).
- Expanded `CONTRIBUTING.md` with: how to claim issues, branch naming, Conventional Commits, dogfooding guidance, getting-help routing.
