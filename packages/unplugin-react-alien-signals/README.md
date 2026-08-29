# unplugin-react-alien-signals

[English](README.md) | [日本語](README.ja.md)

Universal bundler integration for automatic `useSignals()` insertion and the
optional managed render-scope transform in
[`react-alien-signals`](https://www.npmjs.com/package/react-alien-signals).

This package is deliberately the only build-time integration. It keeps the
Babel implementation private, so application configuration is the same across
supported bundlers.

## Status

This workspace package is private while the integration is being completed. It
is not published to npm. The planned package is ESM-only: use an ESM build
configuration and `import`, not CommonJS `require()`.

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
  - `"all"`: additionally transforms every named JSX component. Nested
    callbacks are collected by their owning component but are never transform
    targets themselves.
- `transform`:
  - `"managed"` (default): adds an exact `try` / `finally` boundary, importing
    from the package's `/runtime` entry and closing the render-tracking
    window synchronously at the point the component function returns.
  - `"inject"`: adds bare `useSignals()` for best-effort opt-in. It inserts a
    normal `useSignals()` call without rewriting control flow, so it has the
    same best-effort tracking boundary as a handwritten call — see
    [the boundary design investigation](../../docs/design/use-signals-boundary-design.md)
    for the known sibling-misattribution limitation this mode can expose.
- `reactCompiler`:
  - `"auto"` (default): marks every transformed function with `"use no memo"`,
    so React Compiler does not memoize away the signal reads render tracking
    depends on. Without it, a compiled component caches its JSX and silently
    stops updating after the first signal write.
  - `"off"`: omits the directive. Choose it only when React Compiler is not in
    the build, or when the affected components were verified against
    [the compatibility note](../../docs/design/react-compiler-compatibility.md).
- `importSource`: overrides `react-alien-signals` for a compatible wrapper.
- `reactImportSource`: an additional module specifier whose `memo` and
  `forwardRef` exports count as React's own when the plugin decides whether a
  wrapped function is a component. Recognition is additive, not a replacement:
  a direct import from `"react"` is always recognized, so setting this only
  widens detection and never turns off an existing direct import.
- `include` / `exclude`: functions that filter source module IDs.

Automatic `memo` / `forwardRef` recognition matches only a direct import from
`"react"` or from `reactImportSource`. Importing them through a local
barrel or re-export module (`import { memo } from "./some-local-module"`) is
not resolved automatically, even when that module ultimately re-exports from
`"react"`: the transform sees one file at a time and does not follow re-export
chains. An unrecognized wrapper is not an error — the component is silently
skipped, so signal writes stop re-rendering it. Three workarounds:

- set `reactImportSource` to that module's specifier, if the codebase imports
  through one stable module path (a bare specifier such as `"@app/react"`
  works everywhere; a relative path only matches files that spell it the same
  way);
- import `memo` / `forwardRef` directly from `"react"` at the affected call
  sites;
- opt the component in explicitly with a `@useSignals` comment or a manual
  `useSignals()` call.

`@useSignals` and `@noUseSignals` apply only to their owning function; they do
not affect nested functions. The plugin never adds a second `useSignals()`
call: a direct, namespace, or barrel-imported call it finds is treated as the
function's existing opt-in. A call that is not the function's first statement,
and any barrel-imported call, is left alone in both transform modes. A
first-statement call imported directly or as a namespace from `importSource` is
left in place under `"inject"`, but under `"managed"` (the default) it is
absorbed into the generated boundary: the statement is removed and replaced by
the managed store declaration plus the `try` / `finally` scope, so the function
body is rewritten rather than left byte-for-byte untouched.

Because the default now rewrites those functions, such a call as the first
statement of an `async` or generator function fails the build with
`useSignals transform only supports synchronous, non-generator functions`,
where the previous `"inject"` default compiled it silently. That combination is
already invalid React — hooks require a synchronous function component — so
prefer fixing the function; `transform: "inject"` restores the old behavior if
the file must keep building unchanged.

Reapplying either transform mode is a no-op. The transform runs before other
plugin transforms and skips dependencies and non-JavaScript/TypeScript modules.
Plain `.ts` files are parsed as TypeScript without JSX, while `.tsx`, `.jsx`,
and JavaScript files may use JSX.

## Development benchmark

Run `pnpm bench:transform` from the workspace root to build and measure the
distributed Vite adapter on fixed small and large TSX inputs. The benchmark
reports pass-through, no-candidate, lightweight injection, and managed-boundary
cases; it is a local diagnostic, not a CI performance gate.
