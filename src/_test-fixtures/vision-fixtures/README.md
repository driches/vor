# `_test-fixtures/vision-fixtures/`

Synthetic image fixtures used to exercise the action's
`describe_image_at_ref` agent tool. The directory pairs PNG screenshots
with small TypeScript source files that reference them in JSDoc, so the
agent has a concrete reason to call the vision tool while reviewing the
diff.

Do not import these from production code; the `.ts` files are intentionally
buggy. See the open PR description for the expected reviewer behavior at
the category level (we deliberately do not enumerate per-image expectations
here so the test stays honest).
