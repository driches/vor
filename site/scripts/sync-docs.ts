/**
 * Copies the canonical markdown at the repo root into the Starlight docs
 * collection. The repo root stays the single source of truth — every page on
 * the site is generated from it, so the docs can never drift from what ships in
 * the repo. Runs automatically on `npm run dev` and `npm run build`.
 *
 * Per file it: strips the leading H1 (Starlight renders the title from
 * frontmatter), injects frontmatter + an editUrl back to the source file,
 * rewrites cross-doc links to on-site routes, points every other relative link
 * at GitHub, and fixes asset paths. It never edits the source files.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..');
const repoRoot = join(siteDir, '..');

const REPO = 'driches/vor';
const GITHUB_BLOB = `https://github.com/${REPO}/blob/main`;
const GITHUB_EDIT = `https://github.com/${REPO}/edit/main`;
const BASE = '/vor';

type Page = {
  /** Source path relative to the repo root. */
  src: string;
  /** Output filename inside src/content/docs/. */
  out: string;
  title: string;
  description: string;
};

const PAGES: Page[] = [
  {
    src: 'README.md',
    out: 'overview.md',
    title: 'Overview',
    description:
      'AI-powered PR code review with parallel vulnerability scanning — inline comments anchored to real diff lines.',
  },
  {
    src: 'CHANGELOG.md',
    out: 'changelog.md',
    title: 'Changelog',
    description: 'Release notes and version history for Vor.',
  },
  {
    src: 'SECURITY.md',
    out: 'security.md',
    title: 'Security policy',
    description: 'How to report a vulnerability and which versions are supported.',
  },
  {
    src: 'SUPPORT.md',
    out: 'support.md',
    title: 'Support',
    description: 'Where to ask questions, file bugs, and request features.',
  },
  {
    src: 'CONTRIBUTING.md',
    out: 'contributing.md',
    title: 'Contributing',
    description: 'Development setup, PR workflow, commit conventions, and the release process.',
  },
  {
    src: 'AGENTS.md',
    out: 'ai-agent-guide.md',
    title: 'AI agent guide',
    description: 'The canonical guidelines for AI agents contributing to this codebase.',
  },
  {
    src: 'CODE_OF_CONDUCT.md',
    out: 'code-of-conduct.md',
    title: 'Code of Conduct',
    description: 'Community standards and reporting procedures.',
  },
];

/** Maps a repo-root source path to its on-site route (with base prefix). */
const ROUTE_BY_SRC = new Map<string, string>(
  PAGES.map((p) => [p.src, `${BASE}/${p.out.replace(/\.md$/, '')}/`]),
);

const SVGS = ['logo.svg', 'logo-dark.svg', 'icon.svg'];

function stripLeadingH1(md: string): string {
  const lines = md.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^#\s+/.test(line)) {
      lines.splice(i, 1);
      // Drop a single blank line left behind so the body doesn't start with a gap.
      if (lines[i] !== undefined && lines[i].trim() === '') lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

function rewriteLinks(md: string): string {
  let out = md;

  // 1. Cross-doc markdown links → on-site routes, preserving any #anchor.
  for (const [src, route] of ROUTE_BY_SRC) {
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\]\\((?:\\./)?${escaped}(#[^)\\s]*)?\\)`, 'g');
    out = out.replace(re, (_m, anchor) => `](${route}${anchor ?? ''})`);
  }

  // 2. Any remaining relative markdown link → GitHub blob URL.
  //    Skips absolute URLs, in-page anchors, mailto, and links already pointing
  //    at the site base or an asset path (assets are handled separately).
  const relLink = new RegExp(`\\]\\((?!https?://|#|mailto:|${BASE}/|assets/)([^)\\s]+)\\)`, 'g');
  out = out.replace(relLink, (m, target) => {
    if (/^\.?\//.test(target)) target = target.replace(/^\.\//, '');
    const [path, anchor = ''] = target.split('#');
    if (!path) return m; // pure anchor, leave as-is
    return `](${GITHUB_BLOB}/${path}${anchor ? '#' + anchor : ''})`;
  });

  // 3. Asset references in raw HTML (<img src>, <source srcset>) and markdown images.
  out = out.replace(
    /(src|srcset)="(?:\.\/)?assets\/([^"]+)"/g,
    (_m, attr, file) => `${attr}="${BASE}/${file}"`,
  );
  out = out.replace(/\]\((?:\.\/)?assets\/([^)\s]+)\)/g, (_m, file) => `](${BASE}/${file})`);

  // 4. Relative href="" in raw HTML (e.g. the README's <a href="LICENSE">) → GitHub blob.
  out = out.replace(/href="(?!https?:\/\/|#|mailto:|\/)([^"]+)"/g, (m, target) => {
    const [path, anchor = ''] = String(target).replace(/^\.\//, '').split('#');
    if (!path) return m;
    return `href="${GITHUB_BLOB}/${path}${anchor ? '#' + anchor : ''}"`;
  });

  return out;
}

function buildFrontmatter(page: Page): string {
  return [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `editUrl: ${JSON.stringify(`${GITHUB_EDIT}/${page.src}`)}`,
    '---',
    '',
    `> Synced from [\`${page.src}\`](${GITHUB_BLOB}/${page.src}) — edits belong in the repo root, not here.`,
    '',
  ].join('\n');
}

function syncPages(): void {
  const docsDir = join(siteDir, 'src', 'content', 'docs');
  mkdirSync(docsDir, { recursive: true });

  for (const page of PAGES) {
    const raw = readFileSync(join(repoRoot, page.src), 'utf8');
    const body = rewriteLinks(stripLeadingH1(raw)).replace(/^\n+/, '');
    // Blank line after the frontmatter banner so the first HTML/markdown block
    // isn't folded into the banner blockquote as lazy continuation.
    writeFileSync(join(docsDir, page.out), buildFrontmatter(page) + '\n' + body + '\n', 'utf8');
    console.log(`synced ${page.src} -> src/content/docs/${page.out}`);
  }
}

function syncAssets(): void {
  const assetsSrc = join(repoRoot, 'assets');
  const assetsOut = join(siteDir, 'src', 'assets');
  const publicOut = join(siteDir, 'public');
  mkdirSync(assetsOut, { recursive: true });
  mkdirSync(publicOut, { recursive: true });

  for (const svg of SVGS) {
    copyFileSync(join(assetsSrc, svg), join(assetsOut, svg));
    copyFileSync(join(assetsSrc, svg), join(publicOut, svg));
  }
  // Favicon: the icon-only mark reads on both light and dark backgrounds.
  copyFileSync(join(assetsSrc, 'icon.svg'), join(publicOut, 'favicon.svg'));
  console.log(`synced ${SVGS.length} brand assets into src/assets/ and public/`);
}

syncPages();
syncAssets();
