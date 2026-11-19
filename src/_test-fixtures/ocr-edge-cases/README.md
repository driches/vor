# OCR scanner edge-case fixtures

Synthetic fixtures used to exercise edge-case paths in the `image-ocr` scanner
shipped in PR #63. Not production code — never imported by `src/`.

The directory contains:

- **Format coverage** — the same kind of terminal screenshot encoded as JPG,
  WEBP, and animated GIF, to confirm tesseract handles the formats Vor claims
  to support.
- **Size paths** — one image deliberately above the 1 MB Contents API
  threshold (exercises the Blobs API fallback added in #63) and one image
  deliberately above the 10 MB `max_image_bytes` cap (must be skipped with
  no finding and no crash).
- **Distractor** — a tiny iconographic PNG with no text. The scanner should
  OCR it without producing false-positive findings.
- **Low-contrast** — a screenshot where text is legible to humans but
  near-isoluminant with the background, stressing tesseract confidence.
- **Dedup pair** — a screenshot and a `.env` file that intentionally carry
  the same canonical credential. Observes whether the dedup layer collapses
  the image-ocr finding against the text-secrets-scanner finding.

The screenshots contain fake credentials in canonical example formats (the
same documentation/example values that real secret-scanning regexes match
on). They are NOT real secrets. None of the secret values appear anywhere
in the diff outside of pixel data and the explicit dedup `.env`.

Rename-only behavior (an image renamed without content change must be
skipped) is documented in `src/scanners/image-ocr.ts` via `isImageFile` but
is not exercised here — a rename requires prior history that this single
commit cannot create.
