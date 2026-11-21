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

const RAW_TEXT_HTML_TAGS = new Set(['script', 'style']);
const OPAQUE_NESTABLE_HTML_TAGS = new Set(['svg']);

function readTagNameAt(lower: string, nameStart: number): number {
  let pos = nameStart;
  while (pos < lower.length) {
    const ch = lower.charCodeAt(pos);
    const isAlphaNum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
    if (!isAlphaNum) break;
    pos += 1;
  }
  return pos;
}

function isTagBoundaryChar(ch: number, allowSlash: boolean): boolean {
  return (
    ch === 62 /* > */ ||
    (allowSlash && ch === 47) /* / */ ||
    ch === 32 /* space */ ||
    ch === 9 /* \t */ ||
    ch === 10 /* \n */ ||
    ch === 12 /* \f */ ||
    ch === 13 /* \r */
  );
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
  const stacks = new Map<string, Array<{ openIdx: number; openClose: number }>>();
  const matches = new Map<
    number,
    { tag: string; openClose: number; closeStart: number; closeEnd: number }
  >();

  let rawOpen: {
    tag: string;
    openIdx: number;
    openClose: number;
    depth: number;
    nestable: boolean;
  } | null = null;
  let scan = 0;

  while (scan < lower.length) {
    const idx = lower.indexOf('<', scan);
    if (idx === -1) break;

    if (rawOpen !== null) {
      if (lower.charCodeAt(idx + 1) === 47 /* / */) {
        const nameEnd = readTagNameAt(lower, idx + 2);
        const closeTag = lower.slice(idx + 2, nameEnd);
        const boundary = nameEnd < lower.length ? lower.charCodeAt(nameEnd) : -1;
        if (closeTag === rawOpen.tag && isTagBoundaryChar(boundary, false)) {
          const endBracket = lower.indexOf('>', nameEnd);
          if (endBracket === -1) break;
          rawOpen.depth -= 1;
          if (rawOpen.depth === 0) {
            matches.set(rawOpen.openIdx, {
              tag: rawOpen.tag,
              openClose: rawOpen.openClose,
              closeStart: idx,
              closeEnd: endBracket + 1,
            });
            rawOpen = null;
          }
          scan = endBracket + 1;
          continue;
        }
      } else if (rawOpen.nestable) {
        const nameEnd = readTagNameAt(lower, idx + 1);
        const openTag = lower.slice(idx + 1, nameEnd);
        const boundary = nameEnd < lower.length ? lower.charCodeAt(nameEnd) : -1;
        if (openTag === rawOpen.tag && isTagBoundaryChar(boundary, true)) {
          const endBracket = lower.indexOf('>', nameEnd);
          if (endBracket === -1) break;
          if (html.charCodeAt(endBracket - 1) !== 47 /* / */) {
            rawOpen.depth += 1;
          }
          scan = endBracket + 1;
          continue;
        }
      }
      scan = idx + 1;
      continue;
    }

    if (lower.charCodeAt(idx + 1) === 47 /* / */) {
      const nameEnd = readTagNameAt(lower, idx + 2);
      if (nameEnd === idx + 2) {
        scan = idx + 1;
        continue;
      }
      const closeTag = lower.slice(idx + 2, nameEnd);
      const boundary = nameEnd < lower.length ? lower.charCodeAt(nameEnd) : -1;
      if (!tagSet.has(closeTag) || !isTagBoundaryChar(boundary, false)) {
        scan = idx + 1;
        continue;
      }
      const endBracket = lower.indexOf('>', nameEnd);
      if (endBracket === -1) break;
      const frame = stacks.get(closeTag)?.pop();
      if (frame) {
        matches.set(frame.openIdx, {
          tag: closeTag,
          openClose: frame.openClose,
          closeStart: idx,
          closeEnd: endBracket + 1,
        });
      }
      scan = endBracket + 1;
      continue;
    }

    const nameEnd = readTagNameAt(lower, idx + 1);
    if (nameEnd === idx + 1) {
      scan = idx + 1;
      continue;
    }
    const openTag = lower.slice(idx + 1, nameEnd);
    const boundary = nameEnd < lower.length ? lower.charCodeAt(nameEnd) : -1;
    if (!tagSet.has(openTag) || !isTagBoundaryChar(boundary, true)) {
      scan = idx + 1;
      continue;
    }
    const openClose = lower.indexOf('>', nameEnd);
    if (openClose === -1) break;
    if (html.charCodeAt(openClose - 1) === 47 /* / */) {
      scan = openClose + 1;
      continue;
    }
    if (RAW_TEXT_HTML_TAGS.has(openTag) || OPAQUE_NESTABLE_HTML_TAGS.has(openTag)) {
      rawOpen = {
        tag: openTag,
        openIdx: idx,
        openClose,
        depth: 1,
        nestable: OPAQUE_NESTABLE_HTML_TAGS.has(openTag),
      };
      scan = openClose + 1;
      continue;
    }
    let stack = stacks.get(openTag);
    if (!stack) {
      stack = [];
      stacks.set(openTag, stack);
    }
    stack.push({ openIdx: idx, openClose });
    scan = openClose + 1;
  }

  const out: string[] = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const openIdx = lower.indexOf('<', cursor);
    if (openIdx === -1) {
      out.push(html.slice(cursor));
      break;
    }
    const m = matches.get(openIdx);
    if (m) {
      out.push(html.slice(cursor, openIdx));
      out.push(transform(m.tag, html.slice(m.openClose + 1, m.closeStart)));
      cursor = m.closeEnd;
      continue;
    }
    out.push(html.slice(cursor, openIdx + 1));
    cursor = openIdx + 1;
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
  if (end === 0) {
    return { content: '', truncated: true };
  }
  let sliced = rawBuf.subarray(0, end).toString('utf-8');
  const lastNewline = sliced.lastIndexOf('\n');
  if (lastNewline > sliced.length * 0.8) {
    sliced = sliced.slice(0, lastNewline);
  }
  return { content: `${sliced.trimEnd()}${notice}`, truncated: true };
}
