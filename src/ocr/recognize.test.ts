/**
 * Tests for the OCR module's WASM-free behavior: the size-cap short-circuit
 * (which never loads tesseract) and terminate()-before-use. The real tesseract
 * path is exercised by the offline spike, not in unit tests — it would require
 * the WASM runtime and vendored assets.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTesseractEngine, type Logger } from './recognize.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    notice: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createTesseractEngine', () => {
  it('skips images over the byte cap without loading the engine', async () => {
    const log = makeLogger();
    const engine = createTesseractEngine({ maxImageBytes: 4, logger: log });
    const result = await engine.recognize(Buffer.alloc(64));
    expect(result).toEqual({ text: '', confidence: 0 });
    expect(log.debug).toHaveBeenCalled();
    // No worker was created, so terminate is a no-op that resolves.
    await expect(engine.terminate()).resolves.toBeUndefined();
  });

  it('terminate before any recognize is a safe no-op', async () => {
    const engine = createTesseractEngine({ maxImageBytes: 4, logger: makeLogger() });
    await expect(engine.terminate()).resolves.toBeUndefined();
  });
});
