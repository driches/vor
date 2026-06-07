# Vendored OCR assets

The `image_ocr` scanner and the `describe_image_at_ref` tool run
[`tesseract.js`](https://github.com/naptha/tesseract.js) fully offline — no CDN
fetch — by reading the language model and WASM core from this directory.

Place here (not committed by default; multi-MB binaries):

- `eng.traineddata` — the English LSTM model (plain, **not** gzipped). Copy the
  file `tesseract.js` caches on first online run, or download
  `eng.traineddata` from the `tessdata_fast` release for the bundled core.
- `tesseract-core-simd-lstm.wasm` and `tesseract-core-simd-lstm.wasm.js` —
  copied from `node_modules/tesseract.js-core/`.

`src/ocr/recognize.ts` resolves this directory relative to the built bundle
(`<bundle>/../assets/ocr`); override with the `VOR_OCR_ASSETS_DIR` env var.

When these assets (or the `tesseract.js` runtime) are absent, OCR degrades
gracefully: `image_ocr` and the OCR half of `describe_image_at_ref` return no
text rather than failing the review. The vision half of `describe_image_at_ref`
(visual understanding) needs no local assets — it calls the configured model.
