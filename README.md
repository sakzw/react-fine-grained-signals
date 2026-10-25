# react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

An experimental fine-grained rendering layer for React 19, built on [alien-signals](https://www.npmjs.com/package/alien-signals). It provides small reactive primitives, React hooks, and an opt-in JSX runtime for a deliberately narrow set of direct DOM bindings.

**Requires React 19 or newer.** The JSX runtime uses callback-ref cleanup, which is unavailable in React 18.

## Documentation

See [`docs/README.md`](docs/README.md) for the user documentation index.
The documentation site with live examples is built from [`website/`](website), an independent Vocs project.
For upgrades from v0.2.1, see the [v0.3 migration guide](./docs/migration/v0.3.md).
For earlier upgrades from v0.1.1, see the [v0.2 migration guide](./docs/migration/v0.2.md).
See the [v0.3.0 release notes](./docs/releases/v0.3.0.md) for what changed.

## Installation

```sh
pnpm add react-fine-grained-signals
```

This installs the v0.3 line. If you are upgrading from v0.2.1, see the
[v0.3 migration guide](./docs/migration/v0.3.md) for the upgrade contract.

React (19 or newer) is a peer dependency, and Node.js 22 or newer is required.
The package is ESM-only and publishes its entry points and types through
`exports`, so TypeScript needs `moduleResolution` set to `bundler`, `node16`, or
`nodenext` to resolve `react-fine-grained-signals/utils` and the JSX runtime.
The optional build plugin requires Node.js `^22.18.0 || >=24.11.0` because it
runs on Babel 8.

## Setup

Core primitives and React Hooks do not require the custom JSX runtime or the
build plugin. For manually tracked reads, call `useSignalTracking()` first:

```tsx
import { useSignal, useSignalTracking } from "react-fine-grained-signals";

function Counter() {
  useSignalTracking();
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
/** @jsxImportSource react-fine-grained-signals/jsx */
```

Or opt the whole project in through `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-fine-grained-signals/jsx"
  }
}
```

Vite reads both of those from `tsconfig.json` — with its default transform and
with `@vitejs/plugin-react` alike — so `vite.config.ts` needs no JSX
configuration of its own.

The runtime covers native elements only, and a deliberately narrow set of
props. Signals passed to a React component's props or children are not
unwrapped. Unsupported Signal-valued host props throw a diagnostic instead of
being passed through as an object. See [JSX signal children and host bindings](./docs/guides/jsx-bindings.md)
for the full allow-list, and for toolchains that transform JSX through Babel,
which do not read `tsconfig.json`.

For projects that need reactive Signal children but no direct host bindings,
opt in to the Lite JSX Runtime instead:

```tsx
/** @jsxImportSource react-fine-grained-signals/jsx/lite */
```

or set `jsxImportSource` to `react-fine-grained-signals/jsx/lite`. Lite supports
ordinary React JSX plus Signal children; it does not support Signal-valued
attributes, style bindings, `bindValue`, or `bindChecked`. React's JSX is used
when no custom `jsxImportSource` is configured; setting it to
`react-fine-grained-signals` opts into Full Runtime. Lite can
reduce a bundle only when Full is absent from the same eagerly loaded chunk;
there is no fixed byte saving. See the comparison below and the [JSX guide](./docs/guides/jsx-bindings.md).

| JSX choice | Use it for |
| --- | --- |
| React standard JSX | Ordinary React components and Hooks; no Signal-child normalization or direct DOM binding |
| RFSG Lite JSX | Signal children in native host elements; no direct attribute, style, or form binding |
| RFSG Full JSX | Signal children plus the documented host attribute, style, and explicit form bindings |

### Build plugin — automatic managed tracking

Adds a top-level capture Hook and per-read tracking to eligible functions during
the build. For the best-effort `useSignalTracking()` boundary, select
`transform: "inject"`. The plugin is a separate package:

```sh
pnpm add -D unplugin-react-fine-grained-signals
```

Install matching `0.3.x` versions of the runtime and the plugin.

It then needs a bundler entry point — `/vite`, `/rollup`, `/webpack`,
`/rspack`, or `/esbuild` — added to the build configuration:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

See [Rendering optimization](./docs/guides/rendering-optimization.md) for the options
and for the trade-offs against calling the hook by hand.

## Development

Architecture, design, and implementation history are indexed in
[`development/README.md`](development/README.md).

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
- [@preact/signals-react](https://www.npmjs.com/package/@preact/signals-react) — prior art for the external `useSignals()` boundary's store protocol; see [Prior art](./development/design/use-signals-boundary-design.md#prior-art).
