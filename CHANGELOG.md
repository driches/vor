# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Documentation site at [driches.github.io/vor](https://driches.github.io/vor/).** An Astro + Starlight site with a marketing landing page (feature grid, copy-paste quickstart, example-review mockup) plus the full docs set. Built from `site/`. Content stays in sync automatically: `site/scripts/sync-docs.ts` pulls the canonical root markdown (README, CHANGELOG, SECURITY, SUPPORT, CONTRIBUTING, AGENTS, CODE_OF_CONDUCT) into the docs collection at build time — the repo root remains the single source of truth, so the site can't drift. Deployed by `.github/workflows/pages.yml` on pushes that touch the site or any synced source file. No change to the action or published package.

### Changed (BREAKING)
- **Project renamed: `code-review` → `vor`.** New name comes from the Norse goddess Vór, "from whom nothing can be hidden." The rename touches every external surface:
  - **npm package**: `@driches/code-review` → `@driches/vor`. The old package is deprecated; install `@driches/vor` going forward.
  - **GitHub repo**: `driches/code-review` → `driches/vor`. Action references should change from `uses: driches/code-review@v0` to `uses: driches/vor@v0`. GitHub's automatic redirect will keep old `uses:` lines working temporarily, but pin to the new name.
  - **Config file**: `.code-review.yml` → `.vor.yml`. **Hard rename — no fallback.** Rename your config file when upgrading; the loader no longer looks for `.code-review.yml`.
  - **Security ignore + bundled rules**: `.code-review/security-ignore.yml` → `.vor/security-ignore.yml`; `.code-review/semgrep-rules/` → `.vor/semgrep-rules/`. The action's `security.ignore_file` and `security.scanners.sast.semgrep.custom_rules_path` defaults updated accordingly. Rename the directory in consumer repos when upgrading.
  - **Semgrep rule IDs**: `code-review.n-plus-one.*`, `code-review.raw-sql-concat.*`, `code-review.sync-in-async.*`, `code-review.missing-auth-middleware.*` → `vor.*`. Any `# nosem: code-review.foo` suppression comments or `rule:` matchers in your `.vor/security-ignore.yml` must be updated to the new `vor.*` prefix.
  - **PR comment marker**: The `<!-- driches/code-review: agent-review v1 -->` HTML marker that lets the bot identify and update its own prior review threads is now `<!-- driches/vor: agent-review v1 -->`. After upgrading, comments left by previous versions won't be recognized as prior reviews — the bot will leave them in place and start a new review thread. Either manually delete the old comments or accept the one-time duplicate.
  - **Workflow file convention**: `.github/workflows/code-review.yml` is now suggested as `.github/workflows/vor.yml` in the README. Your existing file keeps working; only the suggested filename in docs changed.

  Migration checklist for a consumer repo:
  1. Update `uses:` to `driches/vor@v0`.
  2. `git mv .code-review.yml .vor.yml` (if present).
  3. `git mv .code-review .vor` (if present).
  4. Search-and-replace `code-review\.` → `vor.` in any `# nosem:` comments or `.vor/security-ignore.yml` rule matchers.
  5. Optionally delete prior bot review threads on open PRs so the new run doesn't post duplicates.

### Docs
- **Comment-trigger docs, plus a dogfood workflow that uses it.** README's Quick start gains a "Trigger from a PR comment" subsection: an `issue_comment` workflow that lets anyone with write access type `/review` on a PR to start or refresh a review. It needs no `allow_auto_trigger` — `issue_comment` isn't one of the `pull_request*` events the manual-only guard in [src/index.ts](src/index.ts) blocks, so it's a manual invocation that's just more ergonomic than the Actions tab, without reintroducing per-push token spend. The snippet checks out the PR head (so `grep_repo_at_ref`, which greps the local checkout, sees the PR's code, not the default branch's) and gates on `author_association` (issue_comment runs in the base repo with secrets available, even on fork PRs). For this repo's own dogfood, a new [`.github/workflows/self-review-comment.yml`](.github/workflows/self-review-comment.yml) wires the same trigger up — building from source and checking out `refs/pull/<n>/head` (the comment-event equivalent of the `gh workflow run … --ref` dispatch in AGENTS.md §4, which now documents both paths). README + AGENTS changes auto-sync to the docs site.
- **README and supporting docs refocused around multi-provider support.** The copy no longer frames Vor as an Anthropic-first tool — Anthropic Claude and OpenAI (GPT / o-series, including `gpt-5-codex`) are now presented as peer providers. Quick start gains an OpenAI snippet alongside the Claude one, and the inputs table documents that bare `codex-*` model ids need an explicit `provider: openai`. References comparing the product to OpenAI's Codex PR-reviewer (`chatgpt-codex-connector[bot]`) were removed; the "receiving review feedback" guidance in AGENTS.md / CONTRIBUTING.md is now phrased for any auto-reviewer bot rather than naming a specific one. SECURITY.md now covers both API keys and SDKs.
- **Corrected the README security-scanning scope and added a languages section to the docs site.** The "Scope (v1)" section previously called SAST a not-yet-active v2 stub, but `src/config/defaults.ts` enables it by default — the bullet now documents the real coverage (ESLint/`tsc`/knip for JS/TS, Ruff for Python, `dart analyze` for Dart, actionlint for GitHub Actions workflows, and Semgrep), with container scanning still noted as the remaining stub. The site landing gained a "Works with your stack" section conveying the same, and feature-card heights were aligned (Starlight's content-flow margins were leaking onto the grid items).

## [0.5.2] - 2026-05-27

### Fixed
- **GitHub Contents API no longer retries 404s.** [`@octokit/plugin-retry`](https://github.com/octokit/plugin-retry.js) compares `error.status` (a number) against `doNotRetry` entries via `Array.prototype.includes`, which uses strict equality. We were passing strings (`'400'`, `'404'`, …), so the 4xx short-circuit never matched and every 404 was retried 3 additional times. On every PR review without an optional file (`.code-review.yml`, `AGENTS.md`, `CLAUDE.md`), that meant **4 HTTP round-trips per missing file** instead of 1. Numeric status codes restore the intended fast-path. Roughly 3× reduction in `getContent` API calls on PRs that don't ship the optional config / context files. Fix in [src/github/client.ts](src/github/client.ts). (#44)

### Docs
- **AGENTS.md, CLAUDE.md, and a refreshed CONTRIBUTING.md.** AGENTS.md is now the canonical contribution guide for AI agents and humans; CLAUDE.md points there. The doc rejects "agentic fluff" (filler comments, decorative emoji, unverified "tested and passing" claims) explicitly, names the four-command local checklist (`lint / tsc / test / verify-dist`) that mirrors CI, and documents the manual self-review dispatch pattern including the required `--ref <PR-head-branch>` when dogfooding prompt / tool / scanner changes. PR template updated to match. (#45)

## [0.5.1] - 2026-05-27

### Fixed
- **Self-review workflow now forwards `pr_number` to the action.** The dispatch workflow (`.github/workflows/self-review.yml`) accepted a `pr_number` input but never passed it through to the action's `pr_number` parameter, so manual `gh workflow run self-review.yml -f pr_number=N` invocations failed to locate the target PR. Fixing the wiring is otherwise a one-line change — no orchestrator / agent behavior change.



### Added
- **`experimental.scanner_findings_in_user_prompt` flag** (opt-in, default false). When enabled, the orchestrator runs scanners FIRST, then injects their findings as a structured list at the top of the agent's user prompt before the agent loop starts. The prompt block tells the agent "these are already detected — don't re-investigate or re-flag, focus your turns on semantic / design / architectural concerns scanners can't catch." Goal: cut agent turns + cost (less duplicate work) AND raise accuracy (agent focuses on what scanners can't catch). Trade-off: orchestration becomes sequential (scanners-then-agent) instead of parallel, adding ~scanner-duration wall-clock latency. A/B comparison via `npm run local-review -- --scanner-findings-in-user-prompt` is the recommended way to validate per-repo before flipping on. Renderer is in [src/agent/user-prompt.ts](src/agent/user-prompt.ts:`renderScannerFindings`); orchestrator gate is in [src/orchestrator.ts](src/orchestrator.ts) under `injectFindings`.

  **Measured impact (Sonnet 4.6, temperature 0.5):**

  | Eval surface | Cost OFF → ON | Recall OFF → ON | Verdict |
  |---|---|---|---|
  | Synthetic 5 cases × 11 truths | $0.222 → $0.188 (**−15%**) | 11/11 → 11/11 (flat) | Clean win — biggest drops on `correctness-pair` (−30%) and `mixed-bag` (−27%) where finding shapes overlap with scanner coverage. |
  | Captured 3 PRs × 1 run | $1.88 → $1.73 (**−8%**) | 4/7 → 5/7 Codex agreement | Aggregate positive but per-case variance is large; `orbitboard-pr-221` jumped 0/2 → 2/2 matched while `jwt-auth` went 2/2 → 1/2. |
  | jwt-auth × 3 replicates per side | mean $0.69 → $0.66 (**−5%**) | mean 1.67/2 → 1.33/2 | σ on both cost (±$0.21) and match-count (±0.58) ≥ effect size. Single-run deltas can't be distinguished from sampling noise at n=3. |

  **Why default OFF.** The synthetic signal is real and clean. The captured-PR signal is dominated by the run-to-run variance Sonnet exhibits at temperature=0.5: on jwt-auth, both configs produce 1/2 or 2/2 matches depending on the sample. Promoting the flag to default would be ahead of the data — it pays off on small PRs whose findings overlap scanner coverage, but on larger PRs the cost win is below the noise floor and the recall trade-off is unmeasurable at small n. Opt in per repo via `.code-review.yml` if your PR shape matches the synthetic profile; verify with `npm run local-review -- --scanner-findings-in-user-prompt` before flipping on.
- **`--scanner-findings-in-user-prompt` flag on `npm run local-review`** for A/B testing the above without committing config changes. Injects a synthetic `.code-review.yml` into the FakeOctokit's `getContent` response for the configured config path.
- **Real-LLM eval harnesses for synthetic + captured cases.** Two new scripts under [scripts/eval/](scripts/eval/):
  - [scripts/eval/synthetic-real.ts](scripts/eval/synthetic-real.ts) — runs the orchestrator (real Anthropic / OpenAI provider, full scanner pipeline) against the dataset's synthetic-bug cases (`truth.yml` + `before/` + `after/` shape). Each case's diff + per-file API entries come from [scripts/eval/diff-synthesis.ts](scripts/eval/diff-synthesis.ts) (extracted from the existing `orchestrator-adapter.ts`); a `FakeOctokit` serves the synthesized bytes. Scoring uses the existing `scoreRun` against `truth.yml` and reports per-case + total recall / precision / F1. CLI flags: `--case`, `--model`, `--max-turns`, `--scanner-findings-in-user-prompt`. Closes a gap in the captured-PR golden eval, which silently filtered out synthetic cases because they lack `meta.yml`.
  - [scripts/eval/captured-real.ts](scripts/eval/captured-real.ts) — runs the orchestrator (full pipeline, not just the bare `runAgent` path the golden eval uses) against captured-PR cases (`meta.yml` + `pr.json` + `files.json` + `diff.patch` + `repo/`). The FakeOctokit serves the captured bytes for the GitHub API surface and uses `git show <ref>:<path>` against the per-case `repo/` snapshot for content reads. The agent's kept comments are compared against the captured Codex baseline via the existing `compare()` helper, reporting per-case agreement-rate / matched / ours-only / codex-only.
- **`OrchestratorOutput.kept_comments`.** New required field on the orchestrator's return value carrying the post-filter, post-dedup `PostedComment[]` it would post (or did post). Populated on every code path that produces a review (live + dry-run); empty on early-exit paths (draft PR, missing key). Exposed so eval harnesses can score the actual posted findings without a side channel into the aggregator. Internal contract change only — no behavior change for production callers.
- **[scripts/eval/diff-synthesis.ts](scripts/eval/diff-synthesis.ts) (extracted pure module).** The diff-synthesis logic in `scripts/eval/orchestrator-adapter.ts` previously sat alongside a module-scope `vi.mock('@octokit/rest', ...)` call that throws when imported outside vitest. Extracting `synthesizeDiff` + its render helpers into their own file lets non-test tooling (synthetic-real.ts, future CLIs) import the function without dragging in the vitest dependency. The adapter re-exports the function so existing `scripts/eval/orchestrator-adapter.test.ts` callers see no behavior change.
- **Local-review CLI: `npm run local-review`.** New [scripts/local-review.ts](scripts/local-review.ts) runs the full production pipeline (deterministic scanners + LLM agent) against a local working copy with no GitHub round-trip. Uses local git as the source of truth (`git diff --name-status` for changed files, `git show <ref>:<path>` for content), constructs a `FakeOctokit` that satisfies the surface the orchestrator + tools call, and runs `runOrchestrator(...)` with `dry_run: true` — the review is logged to stdout and the full structured result saved to `.code-review/local-runs/<timestamp>.json`. Usage: `npm run local-review -- --base main --head HEAD [--model claude-haiku-4-5] [--output path]`. Closes the gap between the golden eval (synthesized PR content, no real scanners) and the production action (requires push + GitHub Actions).
- **`runOrchestrator` accepts `octokitFactory`.** Symmetric to the existing `providerFactory` injection. Production omits this and `createOctokit` (real GitHub API) is used. The new local-review CLI passes a git-backed fake here so the orchestrator's code path is identical to production except for the API layer.
- **Deterministic LLM scope + OpenAI cost controls.** The orchestrator now builds a smaller agent-only PR view before the LLM runs: `exclude.paths` and `exclude.max_diff_lines_per_file` are honored for the agent's `list_changed_files` / `get_pr_diff` tools, while deterministic scanners still receive the full PR and can post lockfile / generated-file / SAST findings. If every changed path is outside LLM scope, the agent call is skipped entirely and only scanners run. OpenAI runs now support provider-specific request controls under `providers.openai` (`service_tier`, `prompt_cache_key`, `prompt_cache_retention`, `reasoning_effort`, `text_verbosity`) plus capability-based reasoning/temperature handling for GPT-5.x, Codex, and o-series models.
- **Custom Semgrep rules + default rule pack.** The SAST orchestrator's semgrep linter now accepts a `security.scanners.sast.semgrep.custom_rules_path` config key (default `.code-review/semgrep-rules`). When the path exists on disk, the linter passes `--config <abs_path>` to semgrep IN ADDITION to the existing `--config=auto` — semgrep merges both rule sets. When the path is unset, empty, or missing on disk, semgrep runs with `--config=auto` only (no behavior change for old configs). See [.code-review/semgrep-rules/README.md](.code-review/semgrep-rules/README.md) for the rule index and suppression instructions.
  - Bundled rules at `.code-review/semgrep-rules/`:
    - `n-plus-one.yml` — `await` inside `for` / `for...of` / `while` / `.forEach` / `.map` (TS/JS) and `for ... in` / `while` (Python). 7 rules. `.forEach(async ...)` and bare `.map(async ...)` are ERROR (correctness bug); other loop shapes are WARNING (sometimes intentionally sequential).
    - `sync-in-async.yml` — `fs.readFileSync` / `writeFileSync` / `execSync` / `spawnSync` / `execFileSync` inside async function or async arrow (TS/JS). 5 rules at ERROR severity.
    - `raw-sql-concat.yml` — string-concat and template-literal SQL (TS/JS) plus f-string / `%` / `.format` SQL (Python). 4 rules at ERROR severity. Tagged template literals like `` sql`...${x}` `` intentionally do NOT match.
    - `missing-auth-middleware.yml` — Express/Koa `POST`/`PUT`/`PATCH`/`DELETE` route handlers with no recognized auth middleware (`authenticate`, `requireAuth`, `isAuthenticated`, `requireUser`, `ensureAuthenticated`, `authMiddleware`, `auth`) in the call, plus the Fastify `route({ method, ... })` shorthand without `preHandler` / `onRequest` / `preValidation`. 5 rules at ERROR severity. `GET`/`HEAD` are intentionally not flagged.
- **tsc (TypeScript compiler) SAST scanner.** New [src/scanners/sast/tsc.ts](src/scanners/sast/tsc.ts) `LinterModule` runs `tsc --noEmit --pretty false --incremental false` against the PR commit and surfaces every diagnostic the TypeScript compiler emits, restricted to lines the PR actually added. In strict-mode repos this catches the long tail of nullable misuse, narrowed-type drift, and contract violations the agent would otherwise spend tool-loop turns rediscovering — at zero LLM cost. Activation: tsconfig.json at workspace root AND `node_modules/.bin/tsc` present; quiet skip otherwise. Errors map to `severity: 'important'`, warnings (rarely emitted) to `'minor'`; category is `'bug'`. Findings carry `tsc/TS<code>` rule ids so the `TS2322`-style codes stay legible in PR comments. Opt out per-repo via `security.scanners.sast.tsc.enabled: false`.
- **Coverage-delta scanner (opt-in).** A new top-level scanner under [src/scanners/coverage-delta.ts](src/scanners/coverage-delta.ts) runs the project's existing coverage tool against the workspace and emits a `test-gap` finding on every PR-added line that the test suite doesn't exercise. Detection priority: **vitest** (when `package.json` declares a `coverage` / `test:coverage` script or has vitest as a (dev)dep) → **jest** (jest config block, `jest.config.*`, or named dep) → **pytest-cov** (any of `pyproject.toml` / `pytest.ini` / `setup.cfg` / `conftest.py` plus a .py file in the diff) → no-op. Output parsing supports both the Istanbul shape vitest/jest emit (`statementMap` + `s`) and coverage.py's `--cov-report=json` shape. Findings carry `severity: minor`, `category: test-gap`, `confidence: medium` and are restricted to `added_lines` (context lines that pre-existed aren't surfaced). **Default: disabled.** Opt in via `security.scanners.coverage_delta.enabled: true` — full coverage runs can be slow and require the project's test deps installed in the workspace. Per-scanner timeout is 240s (matches SAST). Failure-isolated: a crashed test process, missing artifact, or unparseable JSON degrades to an empty findings list with a non-fatal `ScanError`.
- **OpenAI provider support.** The action now talks to OpenAI's Responses API (`/v1/responses`) in addition to Anthropic. Set `model: gpt-4.1` (or `gpt-4o`, `gpt-4o-mini`, `o4-mini`, etc.) in `.code-review.yml` and supply `openai_api_key` as an action input. Model id is sniffed to pick the provider (`claude-*` → Anthropic, `gpt-*`/`o<digit>`/`chatgpt-*` → OpenAI); explicit `provider: openai | anthropic` override is also supported.
- **`LLMProvider` abstraction** in [src/llm/](src/llm/) — canonical message/tool/response types (`CanonicalMessage`, `CanonicalTool`, `CompleteOptions`, `CompleteResponse`, `CanonicalUsage`), `AnthropicProvider` and `OpenAIProvider` adapters, and a `createProvider({modelId, apiKey, providerHint?})` factory. The agent loop in [src/agent/runner.ts](src/agent/runner.ts) speaks only canonical vocabulary; vendor-specific concerns (Anthropic cache_control sliding window, OpenAI reasoning-item replay via `provider_state`, per-provider budget math) live inside their respective adapters.
- **OpenAI Responses API specifics.** Stateless (`store: false`); reasoning-model safe via `include: ['reasoning.encrypted_content']` for `o*` ids and verbatim replay of `response.output[]` on subsequent turns; `temperature` automatically dropped for o-series (which reject it); flat function tool shape (`{type:'function', name, description, parameters, strict:false}`) rather than the Chat-Completions wrapped form.
- **Three new OpenAI pipeline configs** for the eval harness: [configs/pipeline/gpt-4-1-only.yml](configs/pipeline/gpt-4-1-only.yml), [gpt-4o-mini-only.yml](configs/pipeline/gpt-4o-mini-only.yml), [o4-mini-only.yml](configs/pipeline/o4-mini-only.yml). Mirror the existing `{sonnet,haiku,opus}-only.yml` shape; ready for cross-provider F1/cost comparisons.
- **Self-review workflow runs both providers via matrix.** [.github/workflows/self-review.yml](.github/workflows/self-review.yml) now spawns one job per `{claude-sonnet-4-6, gpt-4.1}` matrix entry on every PR (fail-fast: false). Both API keys are passed every run; the orchestrator skips gracefully via `skipped_no_key_${provider}` when the relevant secret isn't configured.
- **`scripts/smoke-openai.ts`** — live-API smoke test exercising the 2-turn tool-use round-trip (tool_call → tool_result → final text) and the `provider_state` replay. Runs against `gpt-4o-mini` for <$0.001 per invocation.

### Changed
- **`src/util/pricing.ts`** — `ModelPricing.cache_creation` and `cache_read` are now optional (OpenAI rows have no `cache_creation` cost; cached writes are free). Added rows for `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-mini`, `o4-mini`. `costFromUsage` guards the optional fields with `?? 0` so unknown-shape rows compute $0 instead of `NaN`.
- **Eval harness migrated off SDK module mocks.** [scripts/eval/orchestrator-adapter.ts](scripts/eval/orchestrator-adapter.ts) previously did `vi.mock('@anthropic-ai/sdk', ...)` at module scope. It now uses `providerFactory: () => fakeProvider` injection through a new optional field on `OrchestratorInput` and `RunAgentInput`. The new `FakeProvider implements LLMProvider` accepts a canonical `CompleteResponse[]` script and works identically for any provider — no per-vendor mock duplication.
- **`RunRecord.cost.provider: ProviderId`** added to persisted eval records. Historical records without this field default to `'anthropic'` at any future read site.
- **`temperature` is now a `RunAgentInput` knob** with a single `DEFAULT_TEMPERATURE = 0.5` constant. Was previously hardcoded at three sites (runner + both adapters).
- **`action.yml`**: top-level `name` is now "AI Code Review" (was "Claude Code Review"); `model` description mentions OpenAI ids; new `openai_api_key` (required: false) and `provider` (required: false) inputs; `OPENAI_API_KEY` + `INPUT_PROVIDER` env wiring added.
- **Fork-safety check moved from `src/index.ts` into `src/orchestrator.ts`.** Now resolves the provider from config first, then checks for the *relevant* provider's key. New `ended` values: `skipped_no_key_anthropic` and `skipped_no_key_openai` (mirror the existing `skipped_draft` style).

### Operator notes
- **Existing Claude-only consumers are unaffected.** `anthropic_api_key` stays `required: true` in the action input contract; `DEFAULT_CONFIG.model` is still `claude-sonnet-4-6`.
- **Worker delegation (`experimental.worker_delegation.enabled`) is Anthropic-only.** Pre-flight Haiku and the worker tool both call `@anthropic-ai/sdk` directly. When the resolved provider is OpenAI, the worker is silently disabled with a warn log rather than erroring the run — operators who want both will need to use a Claude `model:` value.
- **OpenAI pricing values were sourced as of 2026-05.** Re-verify before each release; vendor rates shift.

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
