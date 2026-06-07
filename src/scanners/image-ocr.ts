/**
 * Deterministic scanner that finds hard-coded credentials inside images
 * committed to a PR. A developer who commits a screenshot of a terminal,
 * `.env` file, or cloud console can leak a live key that the text-diff
 * {@link createSecretsScanner} never sees — it reads only added diff *text*
 * and skips binary files.
 *
 * Pipeline per image file added/modified by the PR:
 *   1. `applies()` inverts the usual gate — this is the ONE scanner that wants
 *      binary image files (every other scanner skips `is_binary`).
 *   2. Read the raw bytes at HEAD via `fileReader.readBinary`.
 *   3. OCR them with the injected {@link OcrEngine} (tesseract by default).
 *   4. Run the same {@link DEFAULT_SECRET_PATTERNS} the text secrets scanner
 *      uses over the extracted text, masking + registering matches identically.
 *
 * Deterministic by construction: tesseract OCR + regex patterns, no LLM. The
 * non-deterministic, token-costed *visual understanding* path lives in the
 * `describe_image_at_ref` agent tool, not here — keeping this scanner within
 * the "scanners are deterministic" invariant (AGENTS.md §2).
 *
 * Failure contract: like every scanner, this MUST NOT throw. A read failure,
 * an unavailable OCR engine, or a misbehaving pattern records a non-fatal
 * `ScanError` and the scan continues.
 *
 * Critical invariant (shared with secrets.ts): the raw match string MUST NEVER
 * appear in `title`, `description`, or any log line — only `evidence.masked_match`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { registerSecret } from '../util/secrets.js';
import { logger as defaultLogger } from '../util/logger.js';
import type {
  Scanner,
  ScannerDeps,
  ScanResult,
  ScanFinding,
  ScanError,
  ScanEvidence,
} from './types.js';
import { expiredIgnoreNotice } from './ignore-list.js';
import { maskSecret } from './secrets.js';
import { DEFAULT_SECRET_PATTERNS, type SecretPattern } from './secrets-patterns.js';
import type { ChangedFile, ScannerId } from '../types.js';
import { createTesseractEngine, type OcrEngine } from '../ocr/recognize.js';

const SCANNER_ID: ScannerId = 'image-ocr';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

// OCR + WASM init is slow relative to regex scanners; give it more than the
// 60s runner default so a couple of screenshots don't trip the per-scanner cap.
const OCR_SCANNER_TIMEOUT_MS = 120_000;

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface ImageOcrScannerOptions {
  /** Override the OCR engine — the DI hook tests use to avoid WASM. */
  engine?: OcrEngine;
  /** Override the pattern set (test hook). Defaults to {@link DEFAULT_SECRET_PATTERNS}. */
  patterns?: readonly SecretPattern[];
  /** Skip images larger than this many bytes. Forwarded to the default engine. */
  maxImageBytes?: number;
  /** OCR language(s), forwarded to the default engine. Defaults to `['eng']`. */
  languages?: readonly string[];
  logger?: Logger;
}

/** Stable 12-char fingerprint over `${rule_id}:${file_path}:${matchOrdinal}`. */
function fingerprintOf(rule_id: string, file_path: string, matchOrdinal: number): string {
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${matchOrdinal}`)
    .digest('hex')
    .slice(0, 12);
}

function buildDescription(pattern: SecretPattern): string {
  return (
    `OCR of this image found a string matching the ${pattern.display_name} format. ` +
    `If this is a real credential it should be revoked immediately and the image ` +
    `removed from version control — committed images are public history.`
  );
}

function isImageFile(f: ChangedFile): boolean {
  return f.is_binary && IMAGE_EXTENSIONS.test(f.path) && f.status !== 'removed';
}

export function createImageOcrScanner(options: ImageOcrScannerOptions = {}): Scanner {
  const log = options.logger ?? defaultLogger;
  const patterns = options.patterns ?? DEFAULT_SECRET_PATTERNS;
  // Lazily construct the real engine so PRs with no images (the common case)
  // never load the WASM runtime. A test-injected engine bypasses this.
  let engine = options.engine;
  const getEngine = (): OcrEngine => {
    if (engine === undefined) {
      engine = createTesseractEngine({
        ...(options.maxImageBytes !== undefined ? { maxImageBytes: options.maxImageBytes } : {}),
        ...(options.languages !== undefined ? { languages: options.languages } : {}),
        logger: log,
      });
    }
    return engine;
  };

  return {
    id: SCANNER_ID,
    timeoutMs: OCR_SCANNER_TIMEOUT_MS,

    applies(files: readonly ChangedFile[]): boolean {
      for (const f of files) {
        if (isImageFile(f)) return true;
      }
      return false;
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;
      const ocrEngine = getEngine();

      try {
        for (const file of deps.changedFiles) {
          if (deps.signal.aborted) break;
          if (!isImageFile(file)) continue;
          files_examined += 1;

          let bytes: Buffer | null;
          try {
            bytes = await deps.fileReader.readBinary({
              owner: deps.owner,
              repo: deps.repo,
              path: file.path,
              ref: deps.head_sha,
            });
          } catch (err) {
            errors.push({
              message: `Failed to read image ${file.path}`,
              cause: (err as Error).message,
              fatal: false,
            });
            continue;
          }
          if (bytes === null) continue;

          const { text, confidence } = await ocrEngine.recognize(bytes);
          if (text.trim() === '') continue;

          let matchOrdinal = 0;
          for (const pattern of patterns) {
            try {
              pattern.pattern.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = pattern.pattern.exec(text)) !== null) {
                const raw = m[1] ?? m[0];
                // Advance past zero-width matches to avoid an infinite loop.
                if (m.index === pattern.pattern.lastIndex) pattern.pattern.lastIndex += 1;
                if (pattern.postCheck && !pattern.postCheck(raw)) continue;

                const rule_id = `secret:${pattern.id}`;
                const evidence: ScanEvidence = {
                  kind: 'ocr',
                  masked_match: maskSecret(raw),
                  pattern_id: pattern.id,
                  ocr_confidence: Math.round(confidence),
                };
                const finding: ScanFinding = {
                  scanner: SCANNER_ID,
                  rule_id,
                  file_path: file.path,
                  // Images have no lines; comments anchor at line 1.
                  line: 1,
                  severity: pattern.severity,
                  category: 'vulnerability',
                  confidence: pattern.confidence,
                  title: `Possible ${pattern.display_name} in image ${path.basename(file.path)}`,
                  description: buildDescription(pattern),
                  evidence,
                  fingerprint: fingerprintOf(rule_id, file.path, matchOrdinal++),
                };

                const match = deps.ignoreList.matches(finding);
                if (match.ignored) {
                  if (match.expired) {
                    void log.notice(expiredIgnoreNotice('image-ocr', finding, match));
                  }
                  continue;
                }
                registerSecret(raw);
                findings.push(finding);
              }
            } catch (err) {
              void log.warn(
                `image-ocr: pattern ${pattern.id} threw on ${file.path}: ${(err as Error).message}`,
              );
              errors.push({
                message: `Pattern ${pattern.id} threw while scanning image ${file.path}`,
                cause: (err as Error).message,
                fatal: false,
              });
              pattern.pattern.lastIndex = 0;
            }
          }
        }
      } finally {
        // Release the WASM worker so it doesn't outlive the scan. Best-effort.
        await ocrEngine.terminate();
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: {
          duration_ms: Date.now() - started,
          files_examined,
          network_calls: 0,
          cache_hits: deps.cache.hit_count,
        },
      };
    },
  };
}
