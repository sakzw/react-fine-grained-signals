// deno-fmt-ignore-file
// biome-ignore format: generated types do not need formatting
// prettier-ignore
import type { PathsForPages } from 'waku/router'

// prettier-ignore
type Page =
  | { path: '/core-signals'; render: 'static' }
  | { path: '/deep-signal'; render: 'static' }
  | { path: '/examples'; render: 'static' }
  | { path: '/getting-started'; render: 'static' }
  | { path: '/'; render: 'static' }
  | { path: '/installation'; render: 'static' }
  | { path: '/jsx-direct-binding'; render: 'static' }
  | { path: '/managed-transform'; render: 'static' }
  | { path: '/react-hooks'; render: 'static' }

// prettier-ignore
declare module 'waku/router' {
  interface RouteConfig {
    paths: PathsForPages<Page>
  }
  interface CreatePagesConfig {
    pages: Page
  }
}
