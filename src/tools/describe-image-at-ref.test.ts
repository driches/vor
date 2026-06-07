import { describe, expect, it, vi } from 'vitest';
import type { FileReader } from '../github/file-reader.js';
import type { OcrEngine } from '../ocr/recognize.js';
import type { VisionClient } from '../vision/describe-image.js';
import type { ToolDeps } from './types.js';
import { makeDescribeImageAtRefTool } from './describe-image-at-ref.js';
import { buildFakeDeps, callTool, getResultJson } from './test-helpers.js';

const HEAD_SHA = 'h'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

function fakeOcr(text: string, confidence = 80): OcrEngine {
  return { recognize: vi.fn().mockResolvedValue({ text, confidence }), terminate: vi.fn() };
}

function fakeVision(description: string): VisionClient {
  return { describe: vi.fn().mockResolvedValue({ description }) };
}

function depsWith(over: {
  reader?: Partial<FileReader>;
  ocrEngine?: OcrEngine;
  visionClient?: VisionClient;
}): ToolDeps {
  const reader: Partial<FileReader> = {
    readBinary: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    ...over.reader,
  };
  const base = buildFakeDeps({ fileReader: reader });
  return {
    ...base,
    ...(over.ocrEngine ? { ocrEngine: over.ocrEngine } : {}),
    ...(over.visionClient ? { visionClient: over.visionClient } : {}),
  };
}

describe('describe_image_at_ref tool', () => {
  it('returns OCR text plus a vision description for an image at HEAD', async () => {
    const deps = depsWith({
      ocrEngine: fakeOcr('AKIAIOSFODNN7EXAMPLE', 91),
      visionClient: fakeVision('AWS console showing an access key.'),
    });
    const tool = makeDescribeImageAtRefTool(deps);

    const r = getResultJson(await callTool(tool, { path: 'docs/aws.png' })) as {
      ok: boolean;
      ref: string;
      ref_sha: string;
      text: string;
      ocr_confidence: number;
      description: string;
    };

    expect(r.ok).toBe(true);
    expect(r.ref).toBe('head');
    expect(r.ref_sha).toBe(HEAD_SHA);
    expect(r.text).toContain('AKIA');
    expect(r.ocr_confidence).toBe(91);
    expect(r.description).toBe('AWS console showing an access key.');
  });

  it('reads BASE when ref=base', async () => {
    const readBinary = vi.fn().mockResolvedValue(Buffer.from('PNG'));
    const deps = depsWith({ reader: { readBinary }, ocrEngine: fakeOcr('hi') });
    const tool = makeDescribeImageAtRefTool(deps);

    await callTool(tool, { path: 'x.png', ref: 'base' });
    expect(readBinary).toHaveBeenCalledWith(expect.objectContaining({ ref: BASE_SHA }));
  });

  it('returns OCR-only (empty description) when no vision client is wired', async () => {
    const deps = depsWith({ ocrEngine: fakeOcr('terminal output') });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'x.png' })) as {
      ok: boolean;
      text: string;
      description: string;
    };
    expect(r.ok).toBe(true);
    expect(r.text).toBe('terminal output');
    expect(r.description).toBe('');
  });

  it('truncates a very long OCR transcript and flags it', async () => {
    const long = 'a'.repeat(25_000);
    const deps = depsWith({ ocrEngine: fakeOcr(long) });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'dense.png' })) as {
      text: string;
      text_truncated: boolean;
    };
    expect(r.text_truncated).toBe(true);
    expect(r.text.length).toBe(20_000);
  });

  it('does not flag truncation for short OCR text', async () => {
    const deps = depsWith({ ocrEngine: fakeOcr('short') });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'x.png' })) as {
      text: string;
      text_truncated: boolean;
    };
    expect(r.text_truncated).toBe(false);
    expect(r.text).toBe('short');
  });

  it('rejects non-image paths without reading', async () => {
    const readBinary = vi.fn();
    const deps = depsWith({ reader: { readBinary }, ocrEngine: fakeOcr('') });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'src/foo.ts' })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('reports not-found when the image is missing at the ref', async () => {
    const deps = depsWith({
      reader: { readBinary: vi.fn().mockResolvedValue(null) },
      ocrEngine: fakeOcr(''),
    });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'gone.png' })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it('enforces image_understanding.max_images across calls', async () => {
    const vision = fakeVision('a description');
    const reader: Partial<FileReader> = {
      readBinary: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    };
    const base = buildFakeDeps({
      fileReader: reader,
      config: { image_understanding: { enabled: true, max_images: 1 } },
    });
    const deps: ToolDeps = { ...base, ocrEngine: fakeOcr('text'), visionClient: vision };
    const tool = makeDescribeImageAtRefTool(deps);

    const r1 = getResultJson(await callTool(tool, { path: 'a.png' })) as { description: string };
    const r2 = getResultJson(await callTool(tool, { path: 'b.png' })) as { description: string };

    expect(r1.description).toBe('a description');
    expect(r2.description).toBe(''); // cap hit — OCR still returned, vision skipped
    expect(vision.describe).toHaveBeenCalledTimes(1);
  });

  it('skips the vision call for bmp (unsupported media type) but still OCRs', async () => {
    const vision = fakeVision('should not be called');
    const deps = depsWith({ ocrEngine: fakeOcr('bmp text'), visionClient: vision });
    const tool = makeDescribeImageAtRefTool(deps);
    const r = getResultJson(await callTool(tool, { path: 'x.bmp' })) as {
      text: string;
      description: string;
    };
    expect(r.text).toBe('bmp text');
    expect(r.description).toBe('');
    expect(vision.describe).not.toHaveBeenCalled();
  });
});
