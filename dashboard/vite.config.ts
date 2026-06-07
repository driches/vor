import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const here = fileURLToPath(new URL('.', import.meta.url));

// Built assets land in the repo's dist/dashboard (git-ignored, shipped via npm
// `files`). `base: './'` so the SPA works when served from ~/.vor/dashboard.
export default defineConfig({
  root: here,
  base: './',
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('../dist/dashboard', import.meta.url)),
    emptyOutDir: true,
  },
});
