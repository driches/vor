<!--
Thanks for sending a PR! A couple of things to know:
- Self-review is manual on this repo (.github/workflows/self-review.yml is workflow_dispatch only). A maintainer dispatches it on PRs that change the prompt, tools, or scanners. See CONTRIBUTING.md for the dispatch command.
- For user-facing changes, please update CHANGELOG.md.
- If you changed anything under src/, run `npm run build && npm run verify-dist` and commit the regenerated dist/. CI's verify-dist step will fail otherwise.
- Using an AI assistant to write this PR? Read AGENTS.md first — same rules apply.
-->

## Summary

<!-- 1-3 sentences. What does this change, and why? -->

## Linked issue

<!-- e.g. Closes #123, or "n/a — drive-by fix" -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test -- --run` passes
- [ ] `npm run verify-dist` passes (rebuilds internally; required whenever `src/` changed)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (only required for user-facing changes)
- [ ] If this touches the agent prompt, tools, or scanners, I've asked a maintainer to dispatch self-review (`gh workflow run self-review.yml --ref <branch> -f pr_number=<N> -R driches/vor`) and addressed any regressions

## Notes for reviewers

<!-- Anything subtle, intentional, or context the diff doesn't carry. -->
