# finance/ — review-action test fixture

This directory is a synthetic stress test for the AI PR-review action in this
repo. The TypeScript here is shaped like a small refund + payout reconciliation
module, but it deliberately contains **subtle, realistic bugs** woven into
plausible production code (unit mismatches, idempotency ordering, JOIN
semantics, TZ math, float equality, etc.).

It is **not** imported from production code paths and must not be. Do not copy
patterns from here.
