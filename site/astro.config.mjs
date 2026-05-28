// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Deployed at https://driches.github.io/vor/.
// `base` must match the repo name so asset + link resolution works under the subpath.
export default defineConfig({
  site: 'https://driches.github.io',
  base: '/vor',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Vor',
      description:
        'AI-powered PR code review with parallel vulnerability scanning. Inline comments anchored to real diff lines — Claude or OpenAI.',
      logo: {
        light: './src/assets/logo.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/driches/vor',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/driches/vor/edit/main/',
      },
      sidebar: [
        {
          label: 'Documentation',
          items: [
            { label: 'Overview', link: '/overview/' },
            { label: 'Changelog', link: '/changelog/' },
            { label: 'Security policy', link: '/security/' },
            { label: 'Support', link: '/support/' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Contributing guide', link: '/contributing/' },
            { label: 'AI agent guide', link: '/ai-agent-guide/' },
            { label: 'Code of Conduct', link: '/code-of-conduct/' },
            { label: 'Evaluation harness', link: '/evaluation/' },
          ],
        },
      ],
    }),
  ],
});
