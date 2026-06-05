# Vor — Differentiation strategy

Maintainer-facing positioning memo. Not synced to the docs site; this is the
internal "why we build what we build" reference for prioritising work against
the competitive field.

## Where the market is (mid-2026)

The AI PR-review field is crowded. The leaders differentiate on:

- **Whole-codebase context** — Greptile indexes the entire repo and reviews
  each PR against it (~82% bug catch rate in independent benchmarks), catching
  issues that depend on callers, shared modules, and internal APIs *outside the
  diff*. This is the single capability Vor most lacked: its agent sees the diff
  plus on-demand, agent-initiated `grep`/`read`, with no proactive cross-file
  impact map.
- **Learning team conventions** — cubic writes team standards as natural-language
  rules and ingests PR-comment history to mirror a team's review style.
- **Multi-agent specialisation + governance** — Qodo 2.0 runs separate
  bug/security/quality/coverage agents in parallel; highest F1 (~60%) of eight
  tools in one comparison.
- **Workflow breadth** — CodeRabbit covers GitHub/GitLab/Bitbucket/Azure DevOps
  with summaries, walkthroughs, sequence diagrams, and high precision.
- **Hybrid static-then-AI** — DeepSource (5,000+ rules, 30+ languages) and
  Copilot+CodeQL already run deterministic analysis before the model. So the
  "deterministic first, AI second" hybrid Vor leans on is now table stakes, not
  a moat.

## Positioning thesis

Vor should not fight CodeRabbit on workflow polish or Greptile on indexing as a
closed SaaS — those are well-funded incumbents. Vor's structural advantages are
things a per-seat SaaS cannot or will not do:

> **Vor is the security-native, codebase-aware code reviewer that runs entirely
> inside your CI on the model you already pay for — your code never leaves your
> runner, and every finding is anchored, suggested-fix-backed, and cost-metered.**

Three things competitors can't easily copy:

1. It's open-source and runs as a GitHub Action with **bring-your-own API key**
   — no code egress to a vendor.
2. Deterministic security is **first-class, not a bolt-on** (CVE via OSV,
   secrets, multi-language SAST, plus debris / migration-safety /
   dependency-hygiene / coverage-delta).
3. The `post_inline_comment` validator makes **hallucinated findings
   structurally impossible** — a comment can only land on a line that exists in
   the diff.

The strategy leans into all three while closing the one real accuracy gap
(codebase context).

## The four wedges

### Wedge 1 — Codebase context (in progress)

The biggest accuracy gap versus Greptile. Vor already *can* reach outside the
diff (`grep_repo_at_ref`, `read_file_at_ref`) but only reactively, and only if
the agent thinks to. We close the gap **without** a heavyweight embeddings index
by adding a deterministic "blast radius" pre-pass: for each changed public
symbol, find its callers/referencers elsewhere in the checkout and hand the
agent a compact cross-file impact map up front. It directly targets "issues that
depend on callers / shared modules / internal APIs" — Greptile's headline — at
zero token cost.

The first build of this wedge has shipped (see CHANGELOG, "Cross-file impact
(blast radius)"). Roadmap beyond it: an optional symbol/definition index for
go-to-definition context; import-graph awareness; and surfacing "this PR changes
a public export used by N files" as an automatic Important finding.

### Wedge 2 — Security-native depth

Vor already out-scans most AI reviewers. Make security the *headline*, not a
feature bullet:

- Activate the `container-cve` stub — scan Dockerfiles/base images against OSV.
- **CVE reachability** — for a flagged dependency CVE, reuse the blast-radius
  grep machinery (Wedge 1) to check whether the vulnerable package is actually
  imported/called on a changed path, and annotate the finding `reachable` vs
  `present-but-unreferenced`. A precision feature competitors mostly lack.
- IaC / SBOM: Semgrep IaC rulesets for Terraform/k8s; an SBOM diff line. Lower
  priority.

### Wedge 3 — Self-hosted & private

Own the niche SaaS structurally can't serve: compliance/regulated teams whose
code can't go to a third-party reviewer.

- Messaging: lead the README/docs with "code never leaves your runner; BYO key;
  usage-cost-metered (`cost_usd` per run), no per-seat tax."
- Features that make it real: self-hosted OSV mirror (already supported via
  `osv_endpoint`), an explicit offline/air-gapped mode doc, and local-model
  support (point the OpenAI adapter at an Ollama/vLLM OpenAI-compatible base
  URL — a small `base_url` passthrough in `providers.openai`). A no-telemetry
  guarantee.

### Wedge 4 — Auto-learn conventions

Vor already reads its own prior-review threads and honours pushback
(`fetchPriorReviewThreads`, `renderPriorReviewThreads`). Extend from *within-PR*
to *across-PR* learning: periodically mine merged-PR review history (which
findings were accepted/resolved vs dismissed/pushed-back) and synthesise
per-repo tuning — auto-adjust severity floors, focus areas, and a generated
`prompt.additions` block. "Gets quieter and sharper the longer it runs on your
repo." This is cubic's wedge, but Vor can do it deterministically and
transparently: the learned rules are written to a committed file the team can
read and edit.

## Proof layer (cross-cutting)

Vor has a real eval harness (`scripts/eval/`, synthetic + captured-PR datasets,
recall/precision/cost). Publish a public benchmark (recall/precision/$ per PR)
versus named competitors. Transparency *is* the differentiation for an
open-source tool — no rival publishes honest cost-per-finding numbers.

## Sources

- Greptile — Best AI Code Review Tools 2026: <https://www.greptile.com/content-library/best-ai-code-review-tools>
- CodeAnt — Best AI Code Review Tools (benchmark): <https://www.codeant.ai/blogs/best-ai-code-review-tools>
- WeTheFlywheel — CodeRabbit/Greptile/Qodo/Bito comparison: <https://wetheflywheel.com/en/guides/best-ai-code-review-tools-2026/>
- DeepSource — AI Code Review Tools compared: <https://deepsource.com/resources/ai-code-review-tools>
- Codegen — AI Code Review Tools for the Agent Era: <https://codegen.com/blog/ai-code-review-tools/>
