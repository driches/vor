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

  it('preserves escaped generics and markup inside code, headings, and list items', () => {
    const html =
      '<html><p>Use <code>Map&lt;string, User&gt;</code> and &amp;lt;tag&amp;gt;.</p>' +
      '<pre><code>&lt;div class="x"&gt;hi&lt;/div&gt;</code></pre>' +
      '<h2>Generic &lt;T&gt; &amp;amp; <code>Array&lt;string&gt;</code></h2>' +
      '<ul><li>Use <code>Result&lt;T, E&gt;</code></li></ul></html>';
    const text = normalizeDocumentText(html, 'text/html');
    expect(text).toContain('Use `Map<string, User>` and &lt;tag&gt;.');
    expect(text).toContain('```\n<div class="x">hi</div>\n```');
    expect(text).toContain('## Generic <T> &amp; `Array<string>`');
    expect(text).toContain('- Use `Result<T, E>`');
  });

  it('handles adversarial unclosed HTML tags in linear time', () => {
    const malicious = `${'<script>'.repeat(50_000)}<p>Safe content</p>`;
    const start = Date.now();
    const text = normalizeDocumentText(malicious, 'text/html');
    const elapsedMs = Date.now() - start;
    expect(text).toBe('Safe content');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('preserves slice alignment when HTML contains expanding non-ASCII uppercase chars and self-closing chrome tags', () => {
    const unicodeHtml = '\u0130<script>bad()</script><h2>Heading</h2><p>Body</p>';
    const unicodeText = normalizeDocumentText(unicodeHtml, 'text/html');
    expect(unicodeText).toContain('\u0130');
    expect(unicodeText).toContain('## Heading');
    expect(unicodeText).toContain('Body');
    expect(unicodeText).not.toContain('bad()');

    const selfClosing = '<svg class="icon"/><p>Keep me</p><svg>drop</svg>';
    expect(normalizeDocumentText(selfClosing, 'text/html')).toBe('Keep me');
  });

  it('handles nested and unbalanced HTML elements in linear time without dropping outer content', () => {
    const nestedPre = '<pre><pre>inner</pre>outer</pre>';
    const preOut = normalizeDocumentText(nestedPre, 'text/html');
    expect(preOut).toContain('inner');
    expect(preOut).toContain('outer');

    const nestedNav = '<nav><nav>a</nav>b</nav><p>Visible</p>';
    const navOut = normalizeDocumentText(nestedNav, 'text/html');
    expect(navOut).toBe('Visible');

    const unbalanced = '<pre><pre>only-one</pre>after';
    const unbalancedOut = normalizeDocumentText(unbalanced, 'text/html');
    expect(unbalancedOut).toContain('only-one');
    expect(unbalancedOut).toContain('after');

    const scriptStr = '<script>const x = "<script>";</script><p>keep</p>';
    expect(normalizeDocumentText(scriptStr, 'text/html')).toBe('keep');
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

  it('never exceeds maxBytes when budget is zero or smaller than the truncation notice', () => {
    expect(truncateUtf8Bytes('a'.repeat(50), 10)).toEqual({ content: '', truncated: true });
    expect(truncateUtf8Bytes('abc', 0)).toEqual({ content: '', truncated: true });
    expect(truncateUtf8Bytes('', 0)).toEqual({ content: '', truncated: false });
    // maxBytes=31 leaves a 2-byte budget after the 29-byte notice, rewinding to 0 before the 4-byte scalar.
    expect(truncateUtf8Bytes(`\u{1D11E}${'a'.repeat(40)}`, 31)).toEqual({
      content: '',
      truncated: true,
    });
  });
});
