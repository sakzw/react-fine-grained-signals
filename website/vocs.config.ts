import { defineConfig } from 'vocs/config'

const repository = 'https://github.com/sakzw/react-fine-grained-signals'

// GitHub Pages project site: https://sakzw.github.io/react-fine-grained-signals/
// Override with SITE_BASE_PATH (for example `/` for a custom domain).
const basePath = process.env.SITE_BASE_PATH ?? '/react-fine-grained-signals'
// Vocs prefixes page links with basePath but not `iconUrl`.
const assetBase = basePath.replace(/\/$/, '')

export default defineConfig({
  title: 'React Fine-Grained Signals',
  titleTemplate: '%s · React Fine-Grained Signals',
  description: 'Fine-grained signal rendering for React 19, built on alien-signals.',
  basePath,
  // Every page is generated at build time; nothing runs on a server.
  renderStrategy: 'full-static',
  iconUrl: `${assetBase}/favicon.svg`,
  checkDeadlinks: true,
  editLink: {
    link: `${repository}/edit/main/website/src/pages/:path`,
    text: 'Suggest changes to this page',
  },
  socials: [{ icon: 'github', link: repository }],
  sidebar: [
    {
      text: 'Introduction',
      items: [
        { text: 'What is it?', link: '/' },
        { text: 'Installation', link: '/installation' },
        { text: 'Getting Started', link: '/getting-started' },
      ],
    },
    {
      text: 'Guides',
      items: [
        { text: 'Core Signals', link: '/core-signals' },
        { text: 'React Hooks', link: '/react-hooks' },
        { text: 'Managed Transform', link: '/managed-transform' },
        { text: 'JSX Direct Binding', link: '/jsx-direct-binding' },
        { text: 'Deep Signal & Collections', link: '/deep-signal' },
      ],
    },
    {
      text: 'Examples',
      items: [{ text: 'Interactive Examples', link: '/examples' }],
    },
  ],
})
