# Docs site

The GitHub Pages site for `driches/vor`, built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build). Published at <https://driches.github.io/vor/>.

## How it stays in sync

The repo root is the single source of truth. `scripts/sync-docs.ts` copies the
canonical markdown (`README.md`, `CHANGELOG.md`, `SECURITY.md`, `SUPPORT.md`,
`CONTRIBUTING.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md`, `docs/golden-dataset.md`)
into `src/content/docs/`, rewriting links and asset paths as it goes. It runs
automatically before `dev` and `build`, so the site can't drift from the repo.

The synced files and brand assets are git-ignored — **never edit
`src/content/docs/*.md` by hand**; change the source at the repo root instead.
Only `src/content/docs/index.mdx` (the landing page) is authored here.

## Develop

```sh
cd site
npm install
npm run dev      # runs the sync, then serves http://localhost:4321/vor/
npm run build    # runs the sync, then builds to dist/
```

## Deployment

`.github/workflows/pages.yml` builds this directory and deploys to GitHub Pages
on every push to `main` that touches the site or any synced source file.

**One-time setup:** in the repo's **Settings → Pages**, set **Source** to
**GitHub Actions**. No `gh-pages` branch is used.
