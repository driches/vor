<!--
Thanks for sending a PR! A couple of things to know:
- A self-review runs automatically on this PR via .github/workflows/self-review.yml.
- For user-facing changes, please update CHANGELOG.md.
- If you changed anything under src/, regenerate dist/ via `npm run build` and commit it. CI's verify-dist step will fail otherwise.
-->

## Summary

<!-- 1-3 sentences. What does this change, and why? -->

## Linked issue

<!-- e.g. Closes #123, or "n/a — drive-by fix" -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build && npm run verify-dist` passes (only required if `src/` changed)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` (only required for user-facing changes)
- [ ] If this touches the agent prompt or tools, I've reviewed the self-review output on this PR for regressions

## Notes for reviewers

<!-- Anything subtle, intentional, or context the diff doesn't carry. -->
