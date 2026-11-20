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

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? full;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function htmlToMarkdownText(html: string): string {
  let out = html;
  // Remove non-content / chrome blocks before converting structural tags.
  out = out.replace(/<(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Preformatted code blocks (unwrap inner <code> if present).
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const clean = decodeHtmlEntities(stripTags(inner)).trim();
    return `\n\`\`\`\n${clean}\n\`\`\`\n`;
  });

  // Inline code spans.
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const clean = decodeHtmlEntities(stripTags(inner)).trim();
    return clean ? `\`${clean}\`` : '';
  });

  // Headings h1..h6 -> Markdown #..######.
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    const hashes = '#'.repeat(Number(lvl));
    const clean = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
    return clean ? `\n${hashes} ${clean}\n` : '\n';
  });

  // List items.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const clean = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
    return clean ? `\n- ${clean}` : '';
  });

  // Block separators -> newlines.
  out = out.replace(
    /<\/?(?:p|div|br|section|article|header|main|aside|blockquote|tr|table|ul|ol|hr|dt|dd)\b[^>]*>/gi,
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
  const totalBytes = Buffer.byteLength(text, 'utf-8');
  if (totalBytes <= maxBytes) {
    return { content: text, truncated: false };
  }

  const notice = `\n\n...(truncated at ${maxBytes} bytes)`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf-8'));
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
