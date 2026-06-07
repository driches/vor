import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { serveStatic } from './static.js';

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

function fakeRes(captured: Captured): ServerResponse {
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(data?: Buffer | string) {
      captured.body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
    },
  } as unknown as ServerResponse;
}

describe('serveStatic', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vor-assets-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>vor</title>');
    writeFileSync(join(root, 'app.js'), 'console.log(1)');
    writeFileSync(join(root, 'secret.txt'), 'SHOULD-NOT-LEAK');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves index.html at root with the right content type', () => {
    const cap: Captured = {};
    serveStatic(fakeRes(cap), root, '/');
    expect(cap.status).toBe(200);
    expect(cap.headers!['Content-Type']).toContain('text/html');
    expect(cap.body!.toString()).toContain('vor');
  });

  it('serves a js asset with the js content type', () => {
    const cap: Captured = {};
    serveStatic(fakeRes(cap), root, '/app.js');
    expect(cap.headers!['Content-Type']).toContain('javascript');
  });

  it('falls back to index.html for unknown SPA routes', () => {
    const cap: Captured = {};
    serveStatic(fakeRes(cap), root, '/runs/abc');
    expect(cap.status).toBe(200);
    expect(cap.body!.toString()).toContain('vor');
  });

  it('refuses path traversal out of the asset root', () => {
    const cap: Captured = {};
    serveStatic(fakeRes(cap), root, '/../../etc/passwd');
    // Confined to root → SPA shell, never the traversed file.
    expect(cap.body!.toString()).toContain('vor');
    expect(cap.body!.toString()).not.toContain('root:');
  });
});
