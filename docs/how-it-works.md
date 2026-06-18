# How it works

## The review pipeline

1. The action fetches PR metadata, the file list, and the full unified diff via the GitHub API.
2. It computes **reviewable line ranges** for each file — the added lines plus context lines inside diff hunks.
3. It loads `.vor.yml` and any convention files listed in `context.include` (CLAUDE.md, AGENTS.md, etc.) from the PR HEAD.
4. It builds a system prompt that includes the repo's conventions, severity calibration, and any `prompt.additions`.
5. It runs a **cross-file impact pre-pass** (blast radius): for each public symbol the PR adds or modifies, grep the checkout for references elsewhere in the codebase. The result is folded into the agent's prompt so it can check call-site compatibility before posting a breaking-change finding.
6. The **agent loop** runs with 9 custom tools and no built-in filesystem or shell access:
   - Read: `get_pr_metadata`, `list_changed_files`, `get_pr_diff`, `read_file_at_ref`, `grep_repo_at_ref`, `read_repo_context_file`
   - Write: `post_inline_comment` (validated), `post_summary` (terminates the loop), `skip_file`
7. In parallel, the security scanners run: `dependency-cve` queries OSV.dev for vulnerabilities in changed lockfiles; `secrets` scans added diff lines for credential patterns; `sast` runs the repo's own linters against changed files.
8. Every `post_inline_comment` call is validated against the reviewable line ranges. On rejection, the agent gets a structured `{ reason, hint }` listing the actual valid ranges so it can self-correct and retry.
9. After `post_summary`, findings from the agent and all scanners are filtered by severity floor, per-file cap, and global cap. If `review.sticky` is on, prior reviews from this agent on the PR are dismissed. A single review is posted via `octokit.pulls.createReview`.

## Why hallucinated line numbers are impossible

The three failure modes that plague naive "ask the AI to review the PR" approaches:

1. **Output is prose, not actionable.** The agent has no free text output channel. Findings can only reach the PR via `post_inline_comment` or `post_summary`. Anything written to stdout is logged for debugging but invisible to the PR.

2. **Comments don't land inline.** The action uses `pulls.createReview` with a `comments[]` array that carries `path`, `line`, `side`, and ` ```suggestion ``` ` blocks. GitHub anchors each one to the exact diff line.

3. **Hallucinated lines.** The `post_inline_comment` validator rejects any `(path, line)` pair outside `reviewable_lines` and returns the valid ranges as a structured hint so the agent retries with a real line. The agent cannot post on a line that doesn't exist in the diff.

## Prior review awareness

On a re-run, the orchestrator fetches the agent's prior inline threads on the PR (identified by a marker in the review body) plus any author replies. These are folded into the agent's prompt so it doesn't re-raise findings the author already closed or pushed back on ("won't fix", "by design", etc.).

A finding is still re-raised if the author acknowledged it without resolving it ("good catch", "fixing in next push") — pushback suppression requires explicit rejection, not just acknowledgment.

## Cross-file impact (blast radius)

Before the agent loop runs, a deterministic zero-token pre-pass extracts the public symbols the PR adds or modifies (TypeScript/JavaScript exports, Python module-level `def`/`class`, exported Go funcs/types) from the diff's added lines, then uses the same `git grep` machinery as the `grep_repo_at_ref` tool to find references to each one elsewhere in the checkout. The result is a compact "Cross-file impact" block in the agent's prompt listing each changed symbol and the files that reference it.

The pass is bounded (`context.blast_radius.max_symbols` defaults to 30, `max_refs_per_symbol` to 8), excludes non-call-site paths (`dist/`, `node_modules/`, prose files like `CHANGELOG.md`), and degrades gracefully — a workspace that isn't a git checkout, or any grep failure, produces an empty map rather than failing the review. Disable per-repo with `context.blast_radius.enabled: false`.
