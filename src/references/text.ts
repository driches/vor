/**
 * Text normalization, HTML-to-markdown conversion, heading extraction, and
 * UTF-8 byte capping for reference documents.
 */

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function safeFromCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return fallback;
  }
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return safeFromCodePoint(code, full);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return safeFromCodePoint(code, full);
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? full;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^<>]+>/g, '');
}

function replaceHtmlElements(
  html: string,
  tagNames: readonly string[],
  transform: (tagName: string, inner: string) => string,
): string {
  // Lowercase ASCII letters only so multi-code-unit Unicode case mappings
  // (e.g. U+0130 -> "i\u0307") cannot shift indices relative to `html`.
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const tagSet = new Set(tagNames);
  // Track tags confirmed to have no closing tag later in the document so
  // repeated unclosed tags remain linear-time rather than O(N^2).
  const noClosingTag = new Set<string>();

  const out: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const openIdx = lower.indexOf('<', cursor);
    if (openIdx === -1) {
      out.push(html.slice(cursor));
      break;
    }

    let nameEnd = openIdx + 1;
    while (nameEnd < lower.length) {
      const ch = lower.charCodeAt(nameEnd);
      const isAlphaNum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
      if (!isAlphaNum) break;
      nameEnd += 1;
    }

    if (nameEnd === openIdx + 1) {
      out.push(html.slice(cursor, openIdx + 1));
      cursor = openIdx + 1;
      continue;
    }

    const boundary = nameEnd < lower.length ? lower.charCodeAt(nameEnd) : -1;
    const isBoundary =
      boundary === 62 /* > */ ||
      boundary === 47 /* / */ ||
      boundary === 32 /* space */ ||
      boundary === 9 /* \t */ ||
      boundary === 10 /* \n */ ||
      boundary === 12 /* \f */ ||
      boundary === 13; /* \r */

    const tagName = lower.slice(openIdx + 1, nameEnd);
    if (!isBoundary || !tagSet.has(tagName) || noClosingTag.has(tagName)) {
      out.push(html.slice(cursor, openIdx + 1));
      cursor = openIdx + 1;
      continue;
    }

    const openClose = lower.indexOf('>', nameEnd);
    if (openClose === -1) {
      out.push(html.slice(cursor));
      break;
    }

    if (html.charCodeAt(openClose - 1) === 47 /* / */) {
      out.push(html.slice(cursor, openClose + 1));
      cursor = openClose + 1;
      continue;
    }

    const closeNeedle = `</${tagName}`;
    let searchFrom = openClose + 1;
    let closeStart = -1;
    let closeEnd = -1;
    while (true) {
      const idx = lower.indexOf(closeNeedle, searchFrom);
      if (idx === -1) break;
      const afterName = idx + closeNeedle.length;
      const nextCh = afterName < lower.length ? lower.charCodeAt(afterName) : -1;
      const validCloseBoundary =
        nextCh === 62 /* > */ ||
        nextCh === 32 /* space */ ||
        nextCh === 9 /* \t */ ||
        nextCh === 10 /* \n */ ||
        nextCh === 12 /* \f */ ||
        nextCh === 13; /* \r */
      if (!validCloseBoundary) {
        searchFrom = afterName;
        continue;
      }
      const endBracket = lower.indexOf('>', afterName);
      if (endBracket === -1) break;
      closeStart = idx;
      closeEnd = endBracket + 1;
      break;
    }

    if (closeStart === -1) {
      noClosingTag.add(tagName);
      out.push(html.slice(cursor, openIdx + 1));
      cursor = openIdx + 1;
      continue;
    }

    out.push(html.slice(cursor, openIdx));
    out.push(transform(tagName, html.slice(openClose + 1, closeStart)));
    cursor = closeEnd;
  }

  return out.join('');
}

function htmlToMarkdownText(html: string): string {
  // Remove non-content / chrome blocks before converting structural tags.
  let out = replaceHtmlElements(
    html,
    ['script', 'style', 'noscript', 'svg', 'nav', 'footer'],
    () => '',
  );

  // Defer HTML entity decoding until after `stripTags` below so escaped `<...>`
  // inside code/headings/list items (e.g. generic type parameters) isn't stripped as markup.
  // Preformatted code blocks (unwrap inner <code> if present).
  out = replaceHtmlElements(out, ['pre'], (_tag, inner) => {
    const clean = stripTags(inner).trim();
    return `\n\`\`\`\n${clean}\n\`\`\`\n`;
  });

  // Inline code spans.
  out = replaceHtmlElements(out, ['code'], (_tag, inner) => {
    const clean = stripTags(inner).trim();
    return clean ? `\`${clean}\`` : '';
  });

  // Headings h1..h6 -> Markdown #..######.
  out = replaceHtmlElements(out, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], (tag, inner) => {
    const hashes = '#'.repeat(Number(tag.slice(1)));
    const clean = stripTags(inner).replace(/\s+/g, ' ').trim();
    return clean ? `\n${hashes} ${clean}\n` : '\n';
  });

  // List items.
  out = replaceHtmlElements(out, ['li'], (_tag, inner) => {
    const clean = stripTags(inner).replace(/\s+/g, ' ').trim();
    return clean ? `\n- ${clean}` : '';
  });

  // Block separators -> newlines.
  out = out.replace(
    /<\/?(?:p|div|br|section|article|header|main|aside|blockquote|tr|table|ul|ol|hr|dt|dd)\b[^<>]*>/gi,
    '\n',
  );

  // Drop remaining markup and decode entities.
  out = decodeHtmlEntities(stripTags(out));
  return out;
}

export function isLikelyBinary(input: Buffer | string): boolean {
  if (Buffer.isBuffer(input)) {
    return input.subarray(0, 8192).includes(0);
  }
  return input.slice(0, 8192).includes('\0');
}

export function normalizeDocumentText(raw: string, contentType?: string): string {
  const lf = raw.replace(/\r\n?/g, '\n');
  const isHtml =
    (contentType !== undefined && contentType.toLowerCase().includes('html')) ||
    /^\s*(?:<!doctype\s+html|<html\b)/i.test(lf);

  const text = isHtml ? htmlToMarkdownText(lf) : lf;
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractDocumentHeadings(markdown: string, maxHeadings = 8): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = trimmed.match(/^#{1,3}\s+(.+?)\s*#*$/);
    if (m?.[1]) {
      headings.push(m[1].trim());
      if (headings.length >= maxHeadings) break;
    }
  }
  return headings;
}

export function truncateUtf8Bytes(
  text: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { content: '', truncated: text.length > 0 };
  }
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= maxBytes) {
    return { content: text, truncated: false };
  }

  const notice = `\n\n...(truncated at ${maxBytes} bytes)`;
  const noticeBytes = Buffer.byteLength(notice, 'utf-8');
  if (noticeBytes >= maxBytes) {
    // Budget cannot even accommodate the truncation notice; return empty so
    // callers' `maxBytes` ceiling is never exceeded.
    return { content: '', truncated: true };
  }
  const budget = maxBytes - noticeBytes;
  const rawBuf = Buffer.from(text, 'utf-8');
  // Avoid cutting inside a multi-byte UTF-8 character (continuation bytes 10xxxxxx).
  let end = Math.min(budget, rawBuf.length);
  while (end > 0 && (rawBuf[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  let sliced = rawBuf.subarray(0, end).toString('utf-8');
  const lastNewline = sliced.lastIndexOf('\n');
  if (lastNewline > sliced.length * 0.8) {
    sliced = sliced.slice(0, lastNewline);
  }
  return { content: `${sliced.trimEnd()}${notice}`, truncated: true };
}
