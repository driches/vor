# `_test-fixtures/correctness/`

Synthetic source files used to exercise the code-review action's
correctness pipeline (the AI agent plus the `n-plus-one` and
`sync-in-async` semgrep rules in `.code-review/semgrep-rules/`).
Do not import these from production code; they intentionally
contain logic and performance bugs.

Each file is named for the kind of issue it carries. See the open
PR description for the expected findings.
