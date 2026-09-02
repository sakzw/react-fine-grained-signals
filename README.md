# react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

An experimental fine-grained rendering layer for React 19, built on [alien-signals](https://www.npmjs.com/package/alien-signals). It provides small reactive primitives, React hooks, and an opt-in JSX runtime for a deliberately narrow set of direct DOM bindings.

**Requires React 19 or newer.** The JSX runtime uses callback-ref cleanup, which is unavailable in React 18.

## Documentation

See [`docs/README.md`](docs/README.md) for guides on using the library, design investigation memos, and the full documentation index.

## Installation

```sh
pnpm add react-fine-grained-signals alien-signals
```

`alien-signals` is a peer dependency, so install it alongside this package.

The optional build plugin for automatic `useSignals()` insertion is installed separately — see [Rendering optimization](docs/rendering-optimization.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

To verify the packed ESM packages from a clean Vite consumer (without workspace
aliases), run:

```sh
pnpm test:consumer
```

The browser proof of concept renders the app on the server, hydrates it with React 19, and exercises direct signal bindings in Chromium:

```sh
pnpm exec playwright install --only-shell chromium
pnpm prepare:e2e
pnpm test:browser
```

Run `pnpm dev:browser` to build the transform package and inspect the same example at `http://127.0.0.1:4173`.

## Acknowledgments

- [alien-signals](https://www.npmjs.com/package/alien-signals) — the signal engine this package builds on.
- [@preact/signals-core](https://www.npmjs.com/package/@preact/signals-core) — benchmark comparison target.
- [@preact/signals-react](https://www.npmjs.com/package/@preact/signals-react) — prior art for the `useSignals()` boundary's store protocol; see [Prior art](docs/design/use-signals-boundary-design.md#prior-art).
