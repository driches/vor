import { describe, expect, it } from 'vitest';
import {
  extractDocumentHeadings,
  isLikelyBinary,
  normalizeDocumentText,
  truncateUtf8Bytes,
} from './text.js';

describe('normalizeDocumentText', () => {
  it('converts HTML pages to clean markdown-like text and strips chrome', () => {
    const html = `<!DOCTYPE html><html><head><script>alert(1)</script><style>body{}</style></head>
      <body>
        <nav><a href="/">Home</a></nav>
        <h1>API &amp; Security Standards</h1>
        <p>Use <code>zod</code> for input validation.</p>
        <ul><li>Never trust client IDs</li><li>Log errors &#x2014; not tokens</li></ul>
        <pre><code>const ok = true;</code></pre>
        <footer>Copyright</footer>
      </body></html>`;
    const text = normalizeDocumentText(html, 'text/html; charset=utf-8');
    expect(text).toContain('# API & Security Standards');
    expect(text).toContain('Use `zod` for input validation.');
    expect(text).toContain('- Never trust client IDs');
    expect(text).toContain('const ok = true;');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Copyright');
  });

  it('normalizes CRLF and collapses excessive blank lines in markdown', () => {
    const md = '# Title\r\n\r\n\r\n\r\nBody line   \r\n';
    expect(normalizeDocumentText(md)).toBe('# Title\n\nBody line');
  });

  it('preserves out-of-range numeric HTML entities without throwing RangeError', () => {
    const html = '<p>Valid &#x2014; &#65; invalid &#x110000; and &#9999999;.</p>';
    const text = normalizeDocumentText(html, 'text/html');
    expect(text).toContain('Valid — A invalid &#x110000; and &#9999999;.');
  });
});

describe('extractDocumentHeadings', () => {
  it('extracts h1-h3 headings while ignoring fenced code comments', () => {
    const md = [
      '# Architecture ADR',
      '```bash',
      '# shell comment ignored',
      '```',
      '## Context',
      '### Decision',
      '#### Too deep',
    ].join('\n');
    expect(extractDocumentHeadings(md)).toEqual(['Architecture ADR', 'Context', 'Decision']);
  });
});

describe('isLikelyBinary & truncateUtf8Bytes', () => {
  it('detects NUL bytes as binary', () => {
    expect(isLikelyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isLikelyBinary('plain text')).toBe(false);
  });

  it('truncates cleanly on UTF-8 boundaries within maxBytes', () => {
    const src = 'a'.repeat(50) + '\n' + 'é'.repeat(40);
    const res = truncateUtf8Bytes(src, 90);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(90);
    expect(res.content).toContain('(truncated at 90 bytes)');
  });
});
