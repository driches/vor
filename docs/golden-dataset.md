# Golden dataset & eval harness

A local-only workflow for measuring how this tool's output compares to another
AI reviewer (Codex, Coderabbit, etc.) on **real PRs from private repos**.

Because real PRs contain proprietary code, **the dataset itself never lives in
this public repo**. It lives in a separate private repo (default name
`code-review-golden`) cloned alongside this one. The harness in `src/eval/`
and `scripts/golden/` reads from that dataset via `GOLDEN_REPO_PATH`.

## Why this exists

To improve the reviewer, you need a stable benchmark. Manual eyeballing of one
PR at a time is slow; running against a captured fixture and comparing to a
trusted reference gives a repeatable signal. The reference here is whatever
other AI reviewer you already trust on your PRs.

This is **not** an F1-against-ground-truth eval. Codex isn't truth — it has
its own false positives, and the same bug often gets flagged on different but
related lines. v1 emits agreement metrics and a disagreement explorer so you
can read the deltas and decide what's a real miss vs. a different (and
possibly equally valid) judgment call.

## Quick start

### 1. Create the private dataset repo

```sh
# On GitHub: create driches/code-review-golden as a private repo (no template).

# Clone it alongside this repo:
cd ..
git clone git@github.com:driches/code-review-golden.git
cd code-review-golden

# Recommended: add this to its .gitignore so per-case repo snapshots stay local
echo "cases/*/repo/" >> .gitignore
git add .gitignore && git commit -m "ignore per-case repo snapshots"
```

The private repo will hold metadata + Codex output + run results + reports.
The actual repo source code for each case lives in `cases/<id>/repo/` and is
gitignored — it stays local (each is a regular `git clone`).

### 2. Capture a PR

```sh
cd ../code-review        # back into this public repo
export GH_TOKEN=ghp_...  # PAT with read access to the source repo
npm run golden:capture -- \
  --pr driches/orbitboard#42 \
  --case-id orbitboard-pr-42 \
  --bot codex
```

This writes `../code-review-golden/cases/orbitboard-pr-42/` containing:

- `meta.yml` — case metadata (owner, repo, SHAs, capture time)
- `pr.json` — raw `octokit.pulls.get` response
- `files.json` — raw `octokit.pulls.listFiles` response
- `diff.patch` — unified diff
- `repo/` — local git clone at the head SHA (gitignored in the private repo)
- `codex/review.json` — Codex's review + inline comments (raw)
- `codex/normalized.json` — same comments mapped to our schema

If the case already exists, the script refuses to overwrite. Use `--force` to
re-baseline (this destroys captured history — do not do this casually).

### 3. Run the eval

```sh
export ANTHROPIC_API_KEY=sk-ant-...
npm run golden:eval -- --case orbitboard-pr-42
```

The eval builds offline `LocalDeps` from the case dir (no GitHub access needed
for the actual review run), runs the agent, and writes:

- `../code-review-golden/cases/<id>/runs/<timestamp>.json` — our findings + summary + cost
- `../code-review-golden/reports/<timestamp>.md` — comparison report

Run multiple cases in one report:

```sh
npm run golden:eval -- --all                 # all captured cases
npm run golden:eval -- --all --filter '^orbit'  # subset by regex
npm run golden:eval -- --case <id> --model claude-haiku-4-5
```

### 4. Read the report

Open `../code-review-golden/reports/<latest>.md`. Each case section has:

- **Matched pairs** — findings both Ours and Codex flagged. Table shows line
  distance, severity tier from each side, and how the match was made (`hunk`
  or `line`).
- **Ours only** — findings only we flagged. Could be true positives Codex
  missed, or false positives we should fix.
- **Codex only** — findings only Codex flagged. Same dual interpretation.
- **Severity delta** — histogram of `RANK(Codex) − RANK(Ours)` on matched
  pairs. `0` = same severity; positive = Codex called it more serious.

The aggregate section at the top sums these across all cases.

## Bot configuration

The capture script ships defaults for two bots:

- **`codex`** (`codex[bot]`) — parses severity from prefixes like `P1`,
  `Critical`, `Important`, `Minor`, `Nit`.
- **`coderabbit`** (`coderabbitai[bot]`) — parses italic markers like
  `_⚠️ potential issue_`, `_nitpick_`.

If your bot login or message format differs (e.g. `chatgpt-codex-connector[bot]`),
pass the literal login as `--bot <login>`. The captured `review.json` is the
ground truth — if your default regex misses, edit
`src/eval/normalize-codex.ts` and re-run normalization from the saved raw
output without re-hitting the API. (A standalone re-normalize script would
be a good follow-up.)

## Privacy & safety

- **The dataset never lives in this public repo.** The harness reads from
  `GOLDEN_REPO_PATH` (default `../code-review-golden`) and refuses to write
  outputs into a path that's inside this repo. `.gitignore` lists
  `/golden/`, `/code-review-golden/`, `/eval-reports/`, `*.golden.json` as a
  safety net.
- **Reports embed snippets.** `body`, `title`, and suggestion blocks may
  contain real code. They go into the private repo, never here.
- **The captured repo snapshot is a regular git clone.** In the private
  repo, add `cases/*/repo/` to `.gitignore` (see step 1) so the source tree
  doesn't get committed alongside the metadata.
- **No `ANTHROPIC_LOG=debug`** in eval runs — it would echo prompts (which
  contain private diff content) to stdout.
- **Bundle hygiene** — `scripts/verify-dist.ts` fails the build if
  `dist/index.js` imports anything under `src/eval/*`, and ESLint blocks
  `src/!(eval)/**` from importing `src/eval/*`. The eval harness is local-only
  and must never ship to action consumers.

## Recommended workflow

- Capture each PR once, when it's fresh and both sides have reviewed it.
- Don't re-capture an existing case — Codex's review changes over time, and
  the head SHA may move. Treat each capture as a frozen baseline.
- Iterate on the agent's system prompt, run `golden:eval --all`, look at the
  report. Wins are when agreement-rate moves up and `our_only` findings stop
  being noise.
- Add new cases as you find PRs where the comparison surfaces something
  interesting (a class of bug Codex misses, a class of false positive we
  produce).

## Automated collection (GitHub Action)

The private dataset repo ships with `.github/workflows/collect-cases.yml`
which runs daily and auto-captures any new PR that has both a Codex review
and a code-review review. **Eval is NOT run automatically** — capture is
free, eval costs Anthropic credits.

### One-time setup

1. **Create a fine-grained PAT** at
   <https://github.com/settings/personal-access-tokens/new>:
   - Resource owner: `driches`
   - Repositories: select every repo you want eligible for capture (must
     include the private dataset repo `code-review-golden` itself, so the
     workflow can commit back)
   - Permissions:
     - **Contents**: Read AND Write
     - **Pull requests**: Read
     - **Metadata**: Read
   - Expiration: 90 days (set a calendar reminder to rotate)

2. **Add the PAT as a secret** on `code-review-golden`:
   `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `GOLDEN_PAT`
   - Value: the token

3. **Verify**: open `Actions → Collect golden cases → Run workflow`. With no
   inputs it'll scan the last 7 days. Watch the job summary for what got
   captured.

### How the discovery works

`scripts/golden/discover.ts` (in this public repo) does the scan:

1. Lists every repo owned by `driches` that the PAT can see.
2. For each repo, paginates recent PRs (default: last 7 days, merged only).
3. For each PR, fetches its reviews and checks both:
   - `review.user.login === 'chatgpt-codex-connector[bot]'` (override with
     `--bot`), AND
   - some `review.body` contains the marker
     `<!-- driches/code-review: agent-review v1 -->` (constant
     `AGENT_REVIEW_MARKER` in `src/github/prior-reviews.ts`).
4. Skips PRs already at `<golden>/cases/<repo>-pr-<N>/meta.yml`.
5. Emits a JSON array on stdout. The workflow pipes that to
   `scripts/golden/capture-batch.ts`.

### Manual runs

```sh
# Locally (uses your gh auth):
export GH_TOKEN=$(gh auth token)
export GOLDEN_REPO_PATH=$HOME/code-review-golden
npm run golden:discover -- --owner driches --lookback-days 14 \
  --golden-path "$GOLDEN_REPO_PATH" --verbose \
  | npm run golden:capture-batch
```

`golden:discover` is read-only; you can run it any time to see what would be
captured without writing anything.

### Tuning

- **Cadence**: edit the `cron:` line in
  `code-review-golden/.github/workflows/collect-cases.yml`. Daily is a
  reasonable default — capture is idempotent, so re-running costs nothing
  when there's no new data.
- **Lookback**: change the workflow input default (`lookback_days`). Longer
  = more PRs scanned per run (slower); shorter = potentially misses PRs that
  get re-reviewed late.
- **Scope**: use the `repo_filter` workflow input to restrict to a regex
  (e.g. `^orbit` to test only orbitboard).
- **Disable**: comment out the `schedule:` block; manual-only via
  `workflow_dispatch`.

### What is NOT automated

- **Eval runs** — these cost real Anthropic credits ($0.10–$1.00 per PR
  depending on size). Add an `ANTHROPIC_API_KEY` secret to the dataset repo
  and add a second workflow if you want weekly automated eval; for now,
  run on-demand: `npm run golden:eval -- --all`.
- **Report sharing** — reports stay in `code-review-golden/reports/`. Never
  paste their contents into public issues or PR descriptions.

## Cost notes

Each eval run hits the Anthropic API at full model price. A single
medium-sized PR with Sonnet 4.6 is typically $0.05–$0.50; an aggressive
agent budget can push higher. The cost is logged per case in the run JSON
(`cost_usd`). For dozens of cases, prefer running on demand rather than on
every push.

## Future work

- **Trace replay** — record the LLM turns per case and replay them
  deterministically so non-LLM code changes can be regression-tested without
  API spend.
- **Human-labeled ground truth** — `cases/<id>/labels.yml` with TP/FP marks
  per finding. Enables real precision/recall instead of agreement-with-Codex.
- **LLM-as-judge** — send each disagreement pair to a cheap model and ask
  "are these the same finding?". Cache verdicts under `cases/<id>/judgments/`.
- **Re-normalize script** — apply a tuned `BotConfig` to existing
  `review.json` without re-capturing.
