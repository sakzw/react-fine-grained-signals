# unplugin-react-alien-signals

Universal bundler integration for the managed render-scope transform in
[`react-alien-signals`](https://www.npmjs.com/package/react-alien-signals).

This package is deliberately the only build-time integration. It keeps the
Babel implementation private, so application configuration is the same across
supported bundlers.

## Status

This workspace package is private while the integration is being completed. It
is not published to npm.

## Planned installation

This package is not published yet; the following command documents the
intended release API.

```sh
pnpm add -D unplugin-react-alien-signals
```

`react-alien-signals` is a peer dependency.

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

## Other bundlers

Use the matching entry point in the same way:

| Bundler | Entry point |
| --- | --- |
| Rollup | `unplugin-react-alien-signals/rollup` |
| Webpack | `unplugin-react-alien-signals/webpack` |
| Rspack | `unplugin-react-alien-signals/rspack` |
| esbuild | `unplugin-react-alien-signals/esbuild` |

```ts
import signals from "unplugin-react-alien-signals/webpack";

export default {
  plugins: [signals({ mode: "auto" })],
};
```

## Options

- `mode`:
  - `"manual"`: only an explicit first-statement imported `useSignals()` call
    or a `@useSignals` comment on a named component/custom hook opts it in.
  - `"auto"` (default): additionally transforms named JSX components and
    named `useX` custom hooks that read `.value`.
  - `"all"`: additionally transforms every named JSX component.
- `importSource`: overrides `react-alien-signals` for a compatible wrapper.
- `include` / `exclude`: functions that filter source module IDs.

`@noUseSignals` always excludes a function. The transform runs before other
plugin transforms and skips dependencies and non-JavaScript/TypeScript modules.
