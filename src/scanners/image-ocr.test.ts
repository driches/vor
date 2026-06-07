/**
 * Tests for the image-ocr scanner.
 *
 * Covers the `createImageOcrScanner({ engine, patterns, logger })` factory with
 * an injected fake {@link OcrEngine} (no WASM): applies() image gate, the
 * AWS-key-in-screenshot happy path, masking + registerSecret integration,
 * empty-OCR skip, ignore-list suppression, read-failure recovery, and worker
 * termination.
 *
 * Shares the redactor-global cleanup discipline with secrets.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { ChangedFile } from '../types.js';
import type { FileReader } from '../github/file-reader.js';
import { InMemoryScanCache } from './cache.js';
import { createImageOcrScanner } from './image-ocr.js';
import type { OcrEngine, OcrResult } from '../ocr/recognize.js';
import { _clearRegisteredSecrets, redact } from '../util/secrets.js';
import type { SecurityConfig } from '../config/types.js';
import type { IgnoreList, IgnoreMatchResult, ScannerDeps } from './types.js';

afterEach(() => _clearRegisteredSecrets());

const PLANTED_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const MASKED_AWS_KEY = 'AKIA...MPLE';

function makeChangedFile(over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'docs/screenshot.png',
    status: 'added',
    additions: 0,
    deletions: 0,
    reviewable_lines: [],
    added_lines: new Set(),
    language: 'binary',
    is_generated: false,
    is_binary: true,
    size_bytes: 1024,
    head_line_text: new Map(),
    ...over,
  };
}

function makeIgnoreList(result: IgnoreMatchResult = { ignored: false }): IgnoreList {
  return { matches: vi.fn().mockReturnValue(result) };
}

/** Fake engine returning a fixed OCR result and tracking terminate(). */
function makeEngine(result: OcrResult): OcrEngine & { terminated: () => boolean } {
  let terminated = false;
  return {
    recognize: vi.fn().mockResolvedValue(result),
    terminate: vi.fn().mockImplementation(async () => {
      terminated = true;
    }),
    terminated: () => terminated,
  };
}

function makeReader(over: Partial<FileReader> = {}): FileReader {
  return {
    readBinary: vi.fn().mockResolvedValue(Buffer.from('fake-png-bytes')),
    ...over,
  } as unknown as FileReader;
}

function makeScannerDeps(over: Partial<ScannerDeps> = {}): ScannerDeps {
  const config = { scanners: { image_ocr: { enabled: true } } } as unknown as SecurityConfig;
  return {
    octokit: {} as Octokit,
    owner: 'o',
    repo: 'r',
    pull_number: 1,
    head_sha: 'deadbeef',
    changedFiles: [],
    contextFiles: [],
    diff: '',
    workspaceDir: '/tmp',
    cache: new InMemoryScanCache(),
    ignoreList: makeIgnoreList(),
    fileReader: makeReader(),
    config,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('createImageOcrScanner applies()', () => {
  it('matches binary image files only', () => {
    const scanner = createImageOcrScanner({ engine: makeEngine({ text: '', confidence: 0 }) });
    expect(scanner.applies([makeChangedFile({ path: 'a.png' })])).toBe(true);
    expect(scanner.applies([makeChangedFile({ path: 'a.JPG' })])).toBe(true);
  });

  it('skips non-image binaries, text files, and removed images', () => {
    const scanner = createImageOcrScanner({ engine: makeEngine({ text: '', confidence: 0 }) });
    expect(scanner.applies([makeChangedFile({ path: 'a.pdf' })])).toBe(false);
    expect(scanner.applies([makeChangedFile({ path: 'a.ts', is_binary: false })])).toBe(false);
    expect(scanner.applies([makeChangedFile({ path: 'a.png', status: 'removed' })])).toBe(false);
  });
});

describe('createImageOcrScanner scan()', () => {
  it("flags an AWS key OCR'd out of an image, masked", async () => {
    const engine = makeEngine({ text: `key = ${PLANTED_AWS_KEY}\n`, confidence: 87 });
    const scanner = createImageOcrScanner({ engine });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [makeChangedFile({ path: 'docs/aws.png' })] }),
    );

    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.scanner).toBe('image-ocr');
    expect(f.rule_id).toBe('secret:aws-access-key-id');
    expect(f.line).toBe(1);
    expect(f.file_path).toBe('docs/aws.png');
    expect(f.evidence).toMatchObject({
      kind: 'ocr',
      masked_match: MASKED_AWS_KEY,
      pattern_id: 'aws-access-key-id',
      ocr_confidence: 87,
    });
    // The raw key must never appear in title/description.
    expect(f.title.includes(PLANTED_AWS_KEY)).toBe(false);
    expect(f.description.includes(PLANTED_AWS_KEY)).toBe(false);
    // Terminates the worker after the scan.
    expect(engine.terminated()).toBe(true);
  });

  it('cancels a hung recognize when the signal aborts and terminates the worker', async () => {
    // recognize() never resolves on its own — only the abort path can unblock
    // the scan, proving the OCR call observes the signal rather than outliving
    // the per-scanner timeout with a live worker thread.
    let terminated = false;
    const engine: OcrEngine = {
      recognize: vi.fn().mockReturnValue(new Promise<OcrResult>(() => {})),
      terminate: vi.fn().mockImplementation(async () => {
        terminated = true;
      }),
    };
    const controller = new AbortController();
    const scanner = createImageOcrScanner({ engine });
    const scanPromise = scanner.scan(
      makeScannerDeps({
        changedFiles: [makeChangedFile({ path: 'docs/big.png' })],
        signal: controller.signal,
      }),
    );
    // Let the scan reach the in-flight recognize (and attach its abort
    // listener), then abort as the per-scanner timeout would.
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    const result = await scanPromise;
    expect(engine.recognize).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(0);
    expect(terminated).toBe(true);
  });

  it('registers surfaced secrets with the redactor', async () => {
    const engine = makeEngine({ text: `${PLANTED_AWS_KEY}`, confidence: 90 });
    const scanner = createImageOcrScanner({ engine });
    await scanner.scan(makeScannerDeps({ changedFiles: [makeChangedFile({ path: 'a.png' })] }));
    expect(redact(`leaked ${PLANTED_AWS_KEY} here`)).not.toContain(PLANTED_AWS_KEY);
  });

  it('produces no findings when OCR yields no text', async () => {
    const engine = makeEngine({ text: '   \n', confidence: 0 });
    const scanner = createImageOcrScanner({ engine });
    const result = await scanner.scan(makeScannerDeps({ changedFiles: [makeChangedFile()] }));
    expect(result.findings).toHaveLength(0);
  });

  it('suppresses findings the ignore-list matches', async () => {
    const engine = makeEngine({ text: PLANTED_AWS_KEY, confidence: 90 });
    const ignoreList = makeIgnoreList({ ignored: true, reason: 'test fixture' });
    const scanner = createImageOcrScanner({ engine });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [makeChangedFile()], ignoreList }),
    );
    expect(ignoreList.matches).toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
  });

  it('records a non-fatal error and does not throw when readBinary fails', async () => {
    const engine = makeEngine({ text: '', confidence: 0 });
    const reader = makeReader({
      readBinary: vi.fn().mockRejectedValue(new Error('network down')),
    } as Partial<FileReader>);
    const scanner = createImageOcrScanner({ engine });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [makeChangedFile()], fileReader: reader }),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.fatal).toBe(false);
  });

  it('skips files the reader reports missing (null)', async () => {
    const engine = makeEngine({ text: PLANTED_AWS_KEY, confidence: 90 });
    const reader = makeReader({
      readBinary: vi.fn().mockResolvedValue(null),
    } as Partial<FileReader>);
    const scanner = createImageOcrScanner({ engine });
    const result = await scanner.scan(
      makeScannerDeps({ changedFiles: [makeChangedFile()], fileReader: reader }),
    );
    expect(engine.recognize).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
  });
});
