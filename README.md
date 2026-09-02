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

## Setup

The primitives and hooks work as soon as the package is installed — no build
or compiler configuration is involved:

```tsx
import { useSignal, useSignals } from "react-fine-grained-signals";

function Counter() {
  useSignals();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

The two optimizations below are opt-in and independent of each other. Both are
configured after installing, and neither is needed to use the hooks above.

### JSX runtime — direct DOM bindings

Lets a signal used as the child of a native host element update that DOM node
on its own, without re-rendering the component around it.

Opt in one file at a time with a pragma on the first line. Every other file
keeps React's JSX runtime, so this is the form to reach for when only part of
an app needs the direct bindings — it is how
[`examples/react-router`](examples/react-router) is set up:

```tsx
/** @jsxImportSource react-fine-grained-signals */
```

Or opt the whole project in through `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals"
  }
}
```

Vite reads both of those from `tsconfig.json` — with its default transform and
with `@vitejs/plugin-react` alike — so `vite.config.ts` needs no JSX
configuration of its own.

The runtime covers native elements only, and a deliberately narrow set of
props. Signals passed to a React component's props or children are not
unwrapped. See [JSX signal children and host bindings](docs/jsx-bindings.md)
for the full allow-list, and for toolchains that transform JSX through Babel,
which do not read `tsconfig.json`.

### Build plugin — automatic `useSignals()`

Inserts the tracking boundary during the build, so components no longer call
`useSignals()` by hand. It is a separate package:

```sh
pnpm add -D unplugin-react-fine-grained-signals
```

It then needs a bundler entry point — `/vite`, `/rollup`, `/webpack`,
`/rspack`, or `/esbuild` — added to the build configuration:

```ts
// vite.config.ts
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

See [Rendering optimization](docs/rendering-optimization.md) for the options
and for the trade-offs against calling the hook by hand.

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
