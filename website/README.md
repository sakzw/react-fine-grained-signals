# react-fine-grained-signals website

The documentation site for
[react-fine-grained-signals](https://github.com/sakzw/react-fine-grained-signals),
built with [Vocs](https://vocs.dev) (Vite, React 19, Waku/RSC, MDX) and
generated as a fully static site for GitHub Pages.

This directory is its own project. It has its own `package.json`,
`pnpm-lock.yaml`, and `pnpm-workspace.yaml` (which makes it a workspace root,
so pnpm never joins the library's workspace in the parent directory), and its
own TypeScript, Vite, and Vocs configuration. Nothing in it imports from the
parent directory, and the library's own `package.json` and lockfile know
nothing about it.

## Commands

Run everything from this directory.

| Command | What it does |
| --- | --- |
| `node scripts/pack-local-rfsg.mjs` | Repository mode only: build and pack the library and the transform plugin into `vendor/` |
| `pnpm install` | Install the site's dependencies |
| `pnpm dev` | Vite dev server at `http://localhost:5173/react-fine-grained-signals/` |
| `pnpm build` | Static build into `dist/public` |
| `pnpm preview` | Serve `dist/public` the way GitHub Pages will (`http://127.0.0.1:4173/react-fine-grained-signals/`) |
| `pnpm smoke` | Build check in Chromium: every page, assets under the base path, every live demo, no console errors or hydration mismatches. Add `--url http://127.0.0.1:5173` to check a running dev server instead |
| `pnpm typecheck` | `tsc --noEmit` |

`pnpm smoke` needs Playwright's Chromium (`pnpm exec playwright install chromium`),
or `CHROMIUM_PATH` pointing at an installed Chromium binary.

## Where the library comes from

The site depends on `react-fine-grained-signals` and
`unplugin-react-fine-grained-signals` like any other app. The two modes only
differ in where pnpm gets them.

### Repository development mode (current)

v0.3.0 is not on npm yet, so the site uses the library at the current commit:

```sh
node scripts/pack-local-rfsg.mjs  # builds and packs ../ into vendor/*.tgz
pnpm install
pnpm dev
```

`package.json` points at the tarballs (`file:./vendor/…tgz`). They are made by
`pnpm pack`, which runs each package's `prepack` build and rewrites its
`workspace:` ranges, so the site installs exactly what `pnpm publish` would
upload — no source is copied, and React resolves to the site's single copy.
`vendor/` is not committed.

The script packs the checkout in the parent directory. Pass a path, or set
`RFSG_REPO`, when this directory lives somewhere else:

```sh
node scripts/pack-local-rfsg.mjs ../path/to/react-fine-grained-signals
```

Packing is reproducible: the same source gives byte-identical tarballs. When
the library source changes, the tarballs' integrity in `pnpm-lock.yaml` changes
too; run `pnpm install` (not `--frozen-lockfile`) after packing and commit the
updated lockfile.

### Standalone mode (after v0.3.0 is published)

Switch both packages to registry versions — no other file changes:

```sh
pnpm add react-fine-grained-signals@^0.3.0
pnpm add -D unplugin-react-fine-grained-signals@^0.3.0
rm -rf vendor
```

The site then installs and builds with no reference to the library
repository, and `scripts/pack-local-rfsg.mjs` is no longer needed. The
deployment template drops its packing step (see below).

## Configuration notes

- `vocs.config.ts` sets `renderStrategy: 'full-static'` and
  `basePath: '/react-fine-grained-signals'`. Set `SITE_BASE_PATH` (for example
  `/` for a custom domain) to build for another path; `pnpm preview` and
  `pnpm smoke` read the same variable.
- The Vocs CLI starts Vite with `configFile: false`, so it cannot load extra
  Vite plugins. The scripts run Vite directly with `vite.config.ts`, which
  lists the same plugins the CLI uses (`@vitejs/plugin-react`, `vocs/vite`)
  plus the signal transform.
- Vocs renders pages as React Server Components. The live demos are client
  components (`'use client'`) under `src/components/`, and the transform's
  `include` is limited to that directory so it never adds its client-only Hook
  to a server component.
- Two demos opt into the library's JSX runtime per file with
  `/** @jsxImportSource react-fine-grained-signals */`; everything else uses
  React's.

## Deploying to GitHub Pages

`deploy/github-pages.yml` is a workflow template (manual trigger) that packs
the library, builds the site, and deploys `dist/public` with GitHub Pages
actions. It is not active: copy it to `.github/workflows/`, pin the actions to
commit SHAs, and select "GitHub Actions" as the Pages source in the repository
settings. `public/.nojekyll` keeps Pages from dropping Waku's `_`-prefixed
output if the site is ever published from a branch instead.

## Content

The pages in `src/pages` are English adaptations of the guides in the
repository's [`docs/`](../docs), which remain the complete, bilingual
reference; each page links to its full guide.
