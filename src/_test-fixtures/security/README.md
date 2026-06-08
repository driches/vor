# `_test-fixtures/security/`

Synthetic source files used to exercise the code-review action's
security pipeline (AI agent + `secrets` scanner + `sast` semgrep
scanner). Do not import these from production code; they intentionally
contain unsafe patterns.

Each file is named for the kind of issue it carries. See the open
PR description for the expected findings.
