# OCR scanner fixture screenshots

This directory holds synthetic screenshots used to validate the `image_ocr`
scanner end-to-end. Each PNG renders a different category of credential into
pixel content using canonical example values (the kind that the existing
secret-detection regexes are designed to match). One image is a distractor
that contains no credentials so the scanner exercises a full OCR pass that
should produce zero findings.

The `.vor.yml` at the repo root enables the `image_ocr` scanner so the
dogfood review on the PR that adds these files will OCR each image and run
the same secret patterns over the extracted text.

These are non-production test fixtures. They are not consumed by any runtime
code path and should never be merged into a release branch.
