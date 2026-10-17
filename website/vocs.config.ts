import { defineConfig } from 'vocs/config'

const basePath = process.env.VOCS_BASE_PATH ?? '/react-fine-grained-signals/'

export default defineConfig({
  title: 'React Fine-Grained Signals',
  description: 'Fine-grained signal rendering for React 19.',
  srcDir: 'docs',
  basePath,
  renderStrategy: 'full-static',
  sidebar: [
    { text: 'Introduction', link: '/' },
    { text: 'Installation', link: '/installation' },
    { text: 'Getting Started', link: '/getting-started' },
    { text: 'Core Signals', link: '/core-signals' },
    { text: 'React Hooks', link: '/react-hooks' },
    { text: 'Managed Transform', link: '/managed-transform' },
    { text: 'JSX Direct Binding', link: '/jsx-direct-binding' },
    { text: 'Deep Signal / Collections', link: '/deep-signal' },
    { text: 'Interactive Examples', link: '/examples' },
  ],
})
