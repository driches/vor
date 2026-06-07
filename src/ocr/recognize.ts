/**
 * Optical character recognition over image bytes, used to pull text out of
 * screenshots committed to a PR (so the secrets scanner can see credentials
 * baked into a PNG, and the agent can read what a screenshot says).
 *
 * The concrete engine is `tesseract.js` (offline WASM, no API key), but the
 * scanner and tool depend only on the {@link OcrEngine} seam so tests run
 * against a deterministic fake with no WASM and no network. This mirrors the
 * DI pattern the scanner registry uses for the OSV client.
 *
 * Graceful degradation is load-bearing: OCR is opt-in and the tesseract
 * runtime/assets may be absent in the shipped Action bundle (the worker is a
 * `worker_threads` file that can't inline into `dist/index.js`). When the
 * engine can't initialize, every call resolves to empty text rather than
 * throwing — a review must never fail because OCR was unavailable.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from '../util/logger.js';

const localRequire = createRequire(import.meta.url);

export interface OcrResult {
  /** Extracted text. Empty string when nothing was recognized or OCR is unavailable. */
  text: string;
  /** Tesseract's 0–100 mean confidence. 0 when no text / unavailable. */
  confidence: number;
}

/**
 * The seam every consumer depends on. `recognize` MUST NOT throw — failures
 * resolve to `{ text: '', confidence: 0 }`. `terminate` releases the worker.
 */
export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
  terminate(): Promise<void>;
}

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface TesseractEngineOptions {
  /**
   * Directory holding the vendored runtime assets — `eng.traineddata` (plain,
   * not gzipped) and the tesseract-core `.wasm`/`.wasm.js`. Defaults to
   * `assets/ocr` resolved relative to the built bundle, overridable via the
   * `VOR_OCR_ASSETS_DIR` env var so operators can point at a vendored copy.
   */
  assetsDir?: string;
  /** OCR language(s). Defaults to `['eng']`. */
  languages?: readonly string[];
  /** Skip images larger than this many bytes (OCR cost scales with pixels). */
  maxImageBytes?: number;
  logger?: Logger;
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Resolve the default vendored-assets directory. The built bundle lives at
 * `dist/index.js`, so `../assets/ocr` from the bundle dir points at the
 * repo's committed assets. `VOR_OCR_ASSETS_DIR` overrides for non-standard
 * layouts.
 */
function defaultAssetsDir(): string {
  const fromEnv = process.env.VOR_OCR_ASSETS_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // `import.meta.url` resolves both under tsx (src/ocr/) and the CJS bundle
  // (dist/), so `../../assets/ocr` from src or `../assets/ocr` from dist both
  // need normalizing — anchor on the nearest `assets/ocr` by walking up to the
  // package root is overkill; the bundle ships from dist, so go up one.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'assets', 'ocr');
}

/**
 * A `tesseract.js`-backed engine. The worker is created lazily on first
 * `recognize` and reused across calls; if creation fails (module or assets
 * missing) the engine logs once and degrades to empty results for the rest of
 * the run.
 */
export function createTesseractEngine(options: TesseractEngineOptions = {}): OcrEngine {
  const log = options.logger ?? defaultLogger;
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const languages = options.languages ?? ['eng'];
  const langKey = languages.join('+');
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  // `unknown`-typed because tesseract.js is loaded via dynamic import and may
  // be absent; we only call a tiny, runtime-checked slice of its surface.
  type TesseractWorker = {
    recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
    terminate(): Promise<unknown>;
  };
  let workerPromise: Promise<TesseractWorker | null> | undefined;
  let disabled = false;

  async function getWorker(): Promise<TesseractWorker | null> {
    if (disabled) return null;
    if (workerPromise === undefined) {
      workerPromise = (async (): Promise<TesseractWorker | null> => {
        try {
          // Cast through `unknown`: tesseract.js's published `createWorker`
          // overloads don't line up with the minimal shape we call, and the
          // module may be absent entirely in the shipped bundle.
          const tesseract = (await import('tesseract.js')) as unknown as {
            createWorker: (
              langs: string,
              oem?: number,
              opts?: Record<string, unknown>,
            ) => Promise<TesseractWorker>;
          };
          // Vendored, fully-offline configuration (proven by spike): point the
          // worker at local traineddata + wasm core so it never reaches a CDN.
          const worker = await tesseract.createWorker(langKey, 1, {
            langPath: assetsDir,
            cachePath: assetsDir,
            gzip: false,
            workerPath: requireResolveSafe('tesseract.js/src/worker-script/node/index.js'),
            corePath: requireResolveSafe('tesseract.js-core/tesseract-core-simd-lstm.js'),
          });
          return worker;
        } catch (err) {
          disabled = true;
          void log.warn(
            `ocr: tesseract.js engine unavailable (${(err as Error).message}); ` +
              'image OCR disabled for this run. Ensure tesseract.js and the ' +
              'vendored assets/ocr/ files are present.',
          );
          return null;
        }
      })();
    }
    return workerPromise;
  }

  return {
    async recognize(image: Buffer): Promise<OcrResult> {
      if (image.length > maxImageBytes) {
        void log.debug(`ocr: skipping ${image.length}-byte image (over ${maxImageBytes}-byte cap)`);
        return { text: '', confidence: 0 };
      }
      const worker = await getWorker();
      if (worker === null) return { text: '', confidence: 0 };
      try {
        const { data } = await worker.recognize(image);
        return { text: data.text, confidence: data.confidence };
      } catch (err) {
        void log.warn(`ocr: recognize failed: ${(err as Error).message}`);
        return { text: '', confidence: 0 };
      }
    },

    async terminate(): Promise<void> {
      if (workerPromise === undefined) return;
      const worker = await workerPromise;
      if (worker !== null) {
        try {
          await worker.terminate();
        } catch {
          /* terminate is best-effort cleanup; a failure here is not actionable */
        }
      }
    },
  };
}

/**
 * Convenience for callers that OCR a single image and don't manage a long-lived
 * worker (e.g. the `describe_image_at_ref` tool): create an engine, recognize,
 * and always terminate so no `worker_threads` instance lingers and blocks
 * process exit.
 */
export async function recognizeOnce(
  image: Buffer,
  options: TesseractEngineOptions = {},
): Promise<OcrResult> {
  const engine = createTesseractEngine(options);
  try {
    return await engine.recognize(image);
  } finally {
    await engine.terminate();
  }
}

/**
 * `require.resolve` a package path, returning `undefined` (rather than
 * throwing) when it can't be located. Lets tesseract fall back to its own
 * default resolution when we can't pin an explicit worker/core path — and
 * keeps the dynamic-import degrade path intact when the package is absent.
 */
function requireResolveSafe(spec: string): string | undefined {
  try {
    return localRequire.resolve(spec);
  } catch {
    return undefined;
  }
}
