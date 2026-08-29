# unplugin-react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

Universal bundler integration for automatic `useSignals()` insertion and the
optional managed render-scope transform in
[`react-fine-grained-signals`](https://www.npmjs.com/package/react-fine-grained-signals).

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
pnpm add -D unplugin-react-fine-grained-signals
```

`react-fine-grained-signals` is a peer dependency.

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

## Other bundlers

Use the matching entry point in the same way:

| Bundler | Entry point |
| --- | --- |
| Rollup | `unplugin-react-fine-grained-signals/rollup` |
| Webpack | `unplugin-react-fine-grained-signals/webpack` |
| Rspack | `unplugin-react-fine-grained-signals/rspack` |
| esbuild | `unplugin-react-fine-grained-signals/esbuild` |

```ts
import signals from "unplugin-react-fine-grained-signals/webpack";

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
- `importSource`: overrides `react-fine-grained-signals` for a compatible wrapper.
- `reactImportSource`: an additional module specifier whose `memo` and
  `forwardRef` exports count as React's own when the plugin decides whether a
  wrapped function is a component. Recognition is additive, not a replacement:
  a direct import from `"react"` is always recognized, so setting this only
  widens detection and never turns off an existing direct import.
- `include` / `exclude`: functions that filter source module IDs.

Automatic detection never transforms a render callback — a function handed to
one of the array iteration methods `map`, `flatMap`, or `forEach` — because it
runs a variable number of times inside one render of its owner, which the Rules
of Hooks forbid. Recognition covers the inline definition site
(`items.map((item) => …)`), a callback factored out and referenced by its own
binding, whether that binding is a `const` (`const Row = …; items.map(Row)`) or
a function declaration (`function Row() {…}` … `items.map(Row)`), and the
optional-chained form of either (`items?.map(Row)`). Such a callback is left
alone, and its JSX and `.value` reads are collected by the component that
invokes it — including when the callback is defined elsewhere in the same
module, so that component is transformed even when its own body reads no
signal.

The method name is the whole signal here, because a build-time transform cannot
know the object's runtime type. The recognized set is deliberately minimal:
`map` and `flatMap` build an element per item and `forEach` pushes elements into
an accumulator, which are the calls whose callbacks are routinely factored out
under a component-shaped name. Predicate and accumulator methods (`filter`,
`reduce`, `find`, `some`, `every`) are excluded on purpose — their callbacks are
lowercase helpers that are never transform targets anyway, so including them
would only widen the chance of matching an unrelated method of the same name,
and that direction of error is the expensive one: it silently denies a real
component its subscription. A reference passed to any other call is therefore
ordinary component registration and stays eligible — `memo(Row)` and
`forwardRef(Row)` as before, and equally third-party wrappers such as
`observer(Row)` or `connect(…)(Row)`, where React instantiates the returned
component as its own fiber with its own hooks.

This detection has four known limitations:

- A re-assigned alias is not followed, so a PascalCase helper reached through
  `const RowAlias = Row; items.map(RowAlias)` is still treated as a component.
- A render callback passed as a JSX prop value is not recognized.
  `<Grid renderItem={Row} />` is syntactically identical whether `Grid` calls
  `renderItem(item)` a variable number of times per render (a render prop,
  where hook injection is unsafe) or instantiates `Row` as its own component
  (where hook injection is what makes it update), and nothing in the file says
  which — so `Row` keeps its own hook whenever it is independently eligible.
  Prefer inlining the callback at the call site
  (`<Grid renderItem={(item) => <li>{item.value}</li>} />`), which the inline
  detection above already attributes to the owning component, or state the
  intent explicitly on the referenced function with a `@useSignals` /
  `@noUseSignals` comment.
- A callback imported from another module is not followed, because the
  transform sees one file at a time.
- A function used in both roles keeps the exclusion. If `Row` is passed to
  `map` / `flatMap` / `forEach` anywhere in the module and is *also* rendered
  independently as a JSX tag (`<Row item={x} />`), the render-callback usage
  wins: `Row` gets no hook of its own. That is the crash-safe direction — a
  hook there would break hook order in the callback usage — but the
  independently rendered instance then has no subscription and goes stale on
  later signal writes. Split the two roles into two differently named
  functions, one per role, or opt the independently rendered function in
  explicitly with a `@useSignals` comment.

When in doubt, keep such helpers explicit: name them lowercase and without a
`use` prefix, or opt them in manually only when they are genuinely rendered as
components.

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
