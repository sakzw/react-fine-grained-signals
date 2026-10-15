# unplugin-react-fine-grained-signals

[English](README.md) | [日本語](README.ja.md)

Universal bundler integration for automatic render tracking and managed per-read
capture in
[`react-fine-grained-signals`](https://www.npmjs.com/package/react-fine-grained-signals).

This package is deliberately the only build-time integration. It keeps the
Babel implementation private, so application configuration is the same across
supported bundlers.

## Installation

```sh
pnpm add react-fine-grained-signals@^0.3.0
pnpm add -D unplugin-react-fine-grained-signals
```

`react-fine-grained-signals` is a peer dependency. Node.js `^22.18.0 || >=24.11.0`
is required — the range Babel 8, which the transform runs on, declares.

Use the plugin and the runtime from the same release line (`0.3.x` with `0.3.x`): the
generated code imports runtime entry points that change between lines. When
upgrading from v0.1, upgrade both packages together and rename the
`@useSignals` / `@noUseSignals` comments — see the
[v0.2 migration guide](https://github.com/sakzw/react-fine-grained-signals/blob/main/docs/migration/v0.2.md#transform-plugin).

This package ships ESM only; there is no CommonJS build. An ESM build
configuration that uses `import` is the primary setup, but a CommonJS
configuration file (a `webpack.config.js` or `next.config.js` in a project
without `"type": "module"`) can still load it with `require()`: every Node.js
version in the range above loads the ESM entry points through its built-in
`require(esm)` support. The plugin factory is the `default` export:

```js
const signals = require("unplugin-react-fine-grained-signals/webpack").default;
```

## Vite

```ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

### With React Compiler

React Compiler must run *after* this transform: it would otherwise memoize away
the `.value` reads before this plugin could mark the component `"use no memo"`,
and the component would silently stop updating after its first render. List
`signals()` before the plugin that runs the compiler:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" }), react({ compiler: true })],
});
```

In the setup this was tested with (Vite 8, `@vitejs/plugin-react` 6.1),
`react({ compiler: true })` also needs plugin-react's optional
`oxc-transform-react` package. Install it next to `babel-plugin-react-compiler`;
without it the build stops with plugin-react's own "requires the optional
`oxc-transform-react` package" error.

Under Vite the order is also defended at the hook level. The plugin is
`enforce: "pre"`, and its `transform` hook additionally declares
`order: "pre"`, which Vite sorts on within the pre-enforced group. That makes it
run ahead of `@vitejs/plugin-react` 6's compiler step (`react({ compiler: true })`,
itself `enforce: "pre"` with no hook order) even when `react()` is listed first —
before this, that order compiled the component first. This is Vite's ordering,
not an absolute guarantee: a plugin whose transform also declares
`order: "pre"` and is listed earlier still runs first. Keeping `signals()`
first is therefore still the recommended configuration, and it is required
wherever hook ordering does not apply: Rollup orders by array position alone,
and the Babel route (`@rolldown/plugin-babel` with `reactCompilerPreset()`) has
not been verified against this plugin.

Two known limitations apply with React Compiler. Both were present in v0.1.1.

- **Inline render helpers can be memoized by the compiler.** A plain-called
  helper or callback is not a Hook owner. Examples are a PascalCase helper
  called as `Title()` and a render callback such as `items.map(Row)`. The
  transform captures statically proven synchronous reads at the callsite, but
  React Compiler can still compile the helper itself. If it caches the helper's
  JSX, its output can stay stale while the caller re-renders. Put
  `"use no memo"` in the helper body, or render it as a component (`<Title />`).
- **An author-written `"use memo"` is kept.** The plugin does not add
  `"use no memo"` to a function that already states a memoization directive.
  Tested with `babel-plugin-react-compiler` 1.0:
  - With the managed transform, the authored `"use memo"` is preserved and
    repeated signal writes still update the component in the integration test.
    The transform does not add `"use no memo"` when an author explicitly opts
    that function into memoization.
  - With `transform: "inject"`, the compiler compiles the function and can
    memoize away its signal reads, so the component can stop updating.

  Prefer the managed transform with React Compiler. The injection mode has a
  best-effort tracking contract and can become stale when compiler memoization
  removes signal reads.

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
  - `"manual"`: only an explicit first-statement imported `useSignalTracking()` call
    or a `@signalTracking` comment on a named component/custom hook opts it in.
  - `"auto"` (default): additionally transforms named JSX components and
    named `useX` custom hooks that read `.value`.
  - `"all"`: additionally transforms every eligible named JSX component.
    Reads in recognized synchronous array render callbacks can be collected by
    their owner; the callbacks themselves are not transform targets. Reads in
    JSX render props or `children` callbacks are not guaranteed to be captured.
- `transform`:
  - `"managed"` (default and recommended): adds a top-level `useSignalCapture()`
    hook and wraps statically proven synchronous signal reads in short capture
    scopes. Generated code does not move user Hooks into `try` / `finally`.
  - `"inject"` (supported advanced/compatibility mode): adds bare
    `useSignalTracking()` for best-effort opt-in. It inserts a normal
    `useSignalTracking()` call without rewriting control flow, so it has the same
    best-effort tracking boundary as a handwritten call — see
    [the boundary design investigation](../../development/design/use-signals-boundary-design.md)
    for the known sibling-misattribution limitation this mode can expose.
- `reactCompiler`:
  - `"auto"` (default): marks every transformed function with `"use no memo"`,
    so React Compiler does not memoize away the signal reads render tracking
    depends on. Without it, a compiled component caches its JSX and silently
    stops updating after the first signal write.
  - `"off"`: omits the directive. Choose it only when React Compiler is not in
    the build, or when the affected components were verified against
    [the compatibility note](../../development/design/react-compiler-compatibility.md).
- `importSource`: overrides `react-fine-grained-signals` for a compatible wrapper.
  The wrapper must re-export the runtime's root `useSignalTracking` and its
  `/runtime` entry's `useSignalCapture`, which the generated code imports.
- `reactImportSource`: an additional module specifier whose `memo` and
  `forwardRef` exports count as React's own when the plugin decides whether a
  wrapped function is a component. Recognition is additive, not a replacement:
  a direct import from `"react"` is always recognized, so setting this only
  widens detection and never turns off an existing direct import.
- `include` / `exclude`: functions that filter source module IDs.

## Managed tracking contract

In `transform: "managed"`, generated functions call `useSignalCapture()` as a top-level Hook, and the transform wraps statically identified synchronous reads in per-read capture scopes. This is deliberately narrower than the v0.2.1 whole-function `try` / `finally` boundary. The transform does not infer arbitrary callback invocation or follow helper bodies across module boundaries.

| Pattern | Managed behavior |
| --- | --- |
| `state.value.user.name` in a selected function | Captured as one synchronous read expression. |
| `const { user: { profile } } = state.value; profile.name` | A nonempty `const` object pattern made only of static identifier keys, identifier bindings, and nested object patterns is expanded into ordered single-evaluation reads. The source, intermediate properties, and later `profile.name` are captured. Defaults, rest, computed keys, empty nested patterns, annotations, mutable declarations, and reassigned bindings remain unsupported and receive diagnostics when the tracked source is visible. |
| `const { value } = signal` | Destructured signal accessors are not tracked. Read `signal.value` directly. |
| Synchronous helper call | Can be captured at its call site when the selected transform can prove the synchronous call. An imported helper body is not inspected to select a function in `auto` mode. |
| Reads inside a synchronous expression | A call whose inline callback reads a tracked value (`items.filter((item) => item.done.value)`, `reduce`, an IIFE), a call that receives a tracked value (`JSON.stringify(state.value.profile)`, a local helper), `"key" in state.value.profile`, and object/array spread of a tracked value are captured as a whole, so reads the callee or the proxy traps perform afterwards are included. Expressions that also call a Hook keep per-read capture. `for (const item of state.value.items)` copies an array, Map, or Set source inside one capture and tracks `item` as an alias; other iterables stay lazy. |
| Runtime key or alias | A runtime-key read can be captured after the function is selected, but the dynamic read alone does not select a function in `auto`. Static aliases created by the supported simple `const` destructuring form are followed; dynamic destructuring is not. |
| JSX render prop or `children` callback | Capture is not guaranteed because the transform cannot know when or how often the receiver invokes it. Statically visible cases emit a source-located warning. |

An explicit, directly imported first-statement `useSignalTracking()` remains an ambient runtime boundary even when `transform: "managed"` is configured. The plugin preserves the call instead of replacing it with `useSignalCapture()`. This is needed for deep-proxy reads such as `task.done`, which have no `.value` expression for the per-read transform to wrap. Async and generator functions remain ineligible.

`mode: "auto"`, `"manual"`, and `"all"` select functions; they do not change capture semantics. `auto` selects from statically recognized reads and explicit opt-ins, `manual` requires an explicit call or `@signalTracking`, and `all` selects eligible JSX components. `transform: "inject"` inserts the best-effort ambient `useSignalTracking()` boundary for selected functions.

## Render callback detection

Automatic detection never transforms a render callback — a function handed to
one of the array iteration methods `map`, `flatMap`, or `forEach` — because it
runs a variable number of times inside one render of its owner, which the Rules
of Hooks forbid. Recognition covers the inline definition site
(`items.map((item) => …)`), a callback factored out and referenced by its own
binding, whether that binding is a `const` (`const Row = …; items.map(Row)`) or
a function declaration (`function Row() {…}` … `items.map(Row)`), and the
optional-chained form of either (`items?.map(Row)`). The `mapFn` of
`Array.from(arrayLike, mapFn)` (`Array.from({ length: 5 }, Star)`) counts the
same way, and so does a component held in an object that is destructured before
being passed (`const { Row } = parts; items.map(Row)`, or `{ Row: Item }`).
Such a callback is left
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
component as its own fiber with its own hooks. The same registration works
written inline too, as long as the function keeps its own PascalCase name:
`observer(function Row() { … })` is recognized exactly as `observer(Row)` is.
An anonymous or arrow function passed the same way —
`observer((props) => …)` — carries no name for a boundary to attach to, and is
left untransformed.

This detection has the following known limitations:

- A re-assigned alias is not followed, so a PascalCase helper reached through
  `const RowAlias = Row; items.map(RowAlias)` is still treated as a component.
- A statically recognized `.value` read uses dot access, a string-literal key,
  or an immutable local string key such as `const valueKey = "value"`. A
  runtime-key access (`signal[key]`) is captured when the component is already
  selected for transformation, and the runtime records a dependency only if
  that key resolves to a signal accessor. A runtime-key read alone does not
  select a component in `auto` mode. Destructuring a signal itself
  (`const { value } = signal`) is not tracked.
- A render callback passed as a JSX prop value is not recognized.
  `<Grid renderItem={Row} />` is syntactically identical whether `Grid` calls
  `renderItem(item)` a variable number of times per render (a render prop,
  where hook injection is unsafe) or instantiates `Row` as its own component
  (where hook injection is what makes it update), and nothing in the file says
  which — so `Row` keeps its own hook whenever it is independently eligible.
  State the intent explicitly on the referenced function with a
  `@signalTracking` / `@noSignalTracking` comment.

  Writing the callback inline (`<Grid renderItem={(item) => <li>{item.value}</li>} />`)
  does not make its execution timing provable, so the callback is not
  automatically tracked. If `Grid` calls `renderItem` during its *own*
  render, after the owner's function has returned. With the default managed
  transform the owner's boundary is already closed by then, so the reads are
  tracked only if `Grid` has a boundary of its own; otherwise the rendered items
  stay stale. If `Grid` is your own component, opt it in with
  `@signalTracking` (or have it read the signal itself).

  For a statically resolvable inline or same-module callback on a function prop
  other than `onX`, `auto` now emits a source-located warning when the callback
  body reads `.value`. This diagnostic does not infer when the
  receiving component invokes the callback and does not make that read
  reactive; use it to find this boundary, then move the read into a tracked
  component or use an explicit signal-value hook in the component that renders
  the result. Statically resolvable JSX children callbacks receive the same
  warning. Cross-module callbacks and dynamic aliases remain unclassified.
- A direct call to a named/default imported plain helper is captured while it
  runs synchronously if its caller already has a managed boundary. The
  transform cannot inspect that helper to discover a hidden signal read, so
  `auto` will not select a transform when that is the component's only read;
  use `mode: "all"`, `@signalTracking`, or an explicit signal-value Hook. A
  callback returned by an imported helper, or invoked later by another module,
  is not followed because the transform sees one file at a time.
- A callback reached through an object key (`items.map(parts.Row)`, or
  `const { Row } = parts` first) is kept off a boundary, but in `auto` mode its
  `.value` reads are not credited to the caller. A caller that reads no signal
  itself is then left untransformed and does not update; read the signal in the
  caller, use `mode: "all"`, or add `@signalTracking` to the caller.
- A function used in both roles keeps the exclusion. If `Row` is passed to
  `map` / `flatMap` / `forEach` anywhere in the module and is *also* rendered
  independently as a JSX tag (`<Row item={x} />`), the render-callback usage
  wins: `Row` gets no hook of its own. That is the crash-safe direction — a
  hook there would break hook order in the callback usage — but the
  independently rendered instance then has no subscription and goes stale on
  later signal writes. Split the two roles into two differently named
  functions, one per role, or opt the independently rendered function in
  explicitly with a `@signalTracking` comment.

When in doubt, keep such helpers explicit: name them lowercase and without a
`use` prefix, or opt them in manually only when they are genuinely rendered as
components.

## Components called as plain functions

A PascalCase function that the module calls as a plain function — `Title()`,
`Title?.()`, `Title!()`, or, for one held in an object, `ns.Home()`,
`ns?.group?.Home()`, or `this.Home()` from a sibling member — is never
mounted by React as a component of its own: its body simply runs inside the
caller's render. It therefore never gets a boundary of its own, in any mode
including `all`, and its JSX and `.value` reads are collected by the component
or custom hook that makes the call:

```jsx
function Title() { return <h1>{count.value}</h1>; }
// Outer is transformed and subscribes to `count`; Title is left as it is.
function Outer({ show }) { return <div>{show && Title()}</div>; }
```

A boundary inside `Title` would add hooks to `Outer` that run only while `show`
is true — a conditional hook call that React rejects ("Rendered more hooks than
during the previous render"). A call made from an event handler, from the
callback of `useEffect` / `useLayoutEffect` / `useInsertionEffect` /
`useCallback` / `useMemo`, or from an async function runs outside the render,
so its reads are not collected. Custom hooks (`useX`) are called as functions
by design and keep their own boundary exactly as before.

Known limitations:

- The decision is module-wide: a single plain call anywhere in the module takes
  away the function's own boundary. If it is *also* rendered as `<Title />`,
  that instance has no subscription of its own and only refreshes when its
  parent re-renders; the plugin prints a warning for this mix. Use one form
  consistently.
- Only calls through the function's own binding, or through the exact object
  key path it is defined at, are recognized, and only within the module. Any
  link of that path may be optional (`ns?.group.Home()`). Inside a member of
  the same object literal, `this` counts as that path: `this.Home()` in a
  method, an accessor, a `function` property value, or an arrow nested in one
  of those. A nested `function` or class has a `this` of its own and is not
  followed. An alias (`const T = Title; T()`), `Title.call(…)`, and calls from
  other modules are not recognized.
- A function held in an object can also be reached through a computed key:
  `renderers[node.type](node)`, `renderers[key]?.(arg)`,
  `items.map(renderers[key])`, or `this[key](arg)` from a sibling member.
  Every slot that such an access can reach (the
  same depth, under the same static prefix) gets no boundary of its own,
  because a boundary there would run a variable number of times inside the
  caller. Its reads are *not* collected by the caller, because the key is only
  known at runtime. So a caller that reads no signal itself is not transformed
  and does not update on the slot's signals. Read the signal in the caller, or
  add `@signalTracking` to the caller. This also applies when the module
  renders the same slot as `<renderers.User />`.
- The reads are collected only when the caller is itself a component or a
  `useX` hook. A call routed through a lowercase helper
  (`function renderTitle() { return Title(); }`) is not followed, so nothing
  subscribes to those reads; call the function directly from the component, or
  render it as `<Title />`.
- A keyed function (`ns.Home()`) is collected only when this module defines it
  in an object literal bound to the root, or with exactly one member assignment
  (`Card.Header = …`). A sibling's `this.Home()` is collected from the object
  literal that member belongs to.
- An object member the transform cannot see being called keeps its own
  boundary. That covers a member reached through a parameter
  (`function render(set, key) { return set[key](); }`), through an alias
  (`const R = renderers[key]; R(arg)`), through computed destructuring
  (`const { [key]: R } = renderers`), from an object inside an array
  (`columns.map((c) => c.Cell(row))`), or from another module. Calling such a
  member inline is then a hook call inside the caller, which crashes as soon
  as the number of calls changes. Put `@noSignalTracking` on the member: it
  then has no boundary of its own, and a transformed caller tracks its reads
  because they run during the caller's render. Rendering that member as an
  element (`<icons.Check />`) then gives the element no subscription of its
  own.

## Higher-order components

A component a higher-order component returns is recognized even though it has no
name of its own:

```jsx
export const withCount = (Base) => (props) => <Base {...props} count={count.value} />;
```

The inner function is the component here, and it inherits its identity from the
factory's own binding — `withCount` — so `auto` mode subscribes it and a
`@signalTracking` (or `@noSignalTracking`) comment on either the returned function or the
factory's declaration applies to it. Three conditions keep ordinary closures out:
the function must be returned directly by the enclosing function (an explicit
`return`, or an arrow's concise body); the returned function must render JSX
itself; and the enclosing function's name must not be a hook name (`useX`) — or,
if it is a component name (PascalCase), the enclosing function must itself
qualify as a higher-order component factory (described next). A function
returned by a component that fails that test, or by a hook, is instead a render
prop that runs inside that owner's render, not a component of its own.

A PascalCase-named factory qualifies when it takes what looks like a component
as its own parameter — a plain (not destructured) identifier parameter with a
PascalCase name — and renders no JSX itself:

```jsx
export const WithCount = (Base) => (props) => <Base {...props} count={count.value} />;
```

`WithCount` is never transformed itself; the component it returns inherits
`WithCount`'s name exactly as the camelCase form above does. A `useX`-named
factory gets no equivalent exception for the closure it returns, deliberately:
React calls a hook from inside a render already in progress, so anything the
hook hands back may be invoked during that very render, and nothing here can
rule that out. The hook itself is unaffected by this and is still transformed
normally whenever it qualifies — reading a signal, rendering JSX — exactly like
any other hook; only the returned closure inherits no name from it.

The name is inherited from exactly one level out, so a factory returning a
factory (`(a) => (b) => (props) => …`) resolves to nothing, and a `@signalTracking`
comment there reports that rather than silently doing nothing. The one shape
this cannot tell apart is a factory whose result is handed straight to an
iteration method (`items.map(makeRow(prefix))`): that is syntactically a HOC
returning a component, so it gets a boundary of its own. Pass such a callback by
reference (`items.map(Row)`) or write it inline, so the owning component
collects it.

A component can also carry no binding of its own and still be named: one held
as an object property — `Card.Header = () => <p>{count.value}</p>` — or written as an
object-literal method (`export const ns = { Home() { return <p>{count.value}</p>; } }`)
is named by its key, the same way `<Card.Header />` or `<ns.Row />` reaches it
(a lowercase key stays excluded, exactly as a lowercase binding does; getters,
setters, async and generator methods are excluded, and so are class methods,
which only an instance reaches), and a nameless default
export (`export default (props) => <p>{count.value}</p>`) is named after the
module's own file — the identity an `import App from "./App"` already gives it.
Functions held by a class are deliberately excluded, though: a class field
(`class Holder { Row = () => … }`, instance or `static`) and a `this.Row = …`
assignment are never transformed, and a `@signalTracking` comment on one is
reported and ignored. They are reached through `this.Row` or `Holder.Row`, which
the transform cannot follow to tell a component from a function that
`render()` calls directly (`this.Header()`) or passes per item
(`items.map(this.Row)`) — and a hook boundary in either of those runs inside
the class component's render, which React rejects. If such a function is only
ever rendered as an element (`<this.Row />`), it may call `useSignalTracking()`
itself; otherwise read signals in a function component instead.

## `memo` / `forwardRef` recognition

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
- opt the component in explicitly with a `@signalTracking` comment or a manual
  `useSignalTracking()` call.

## `useSignalTracking()` opt-in and rewriting

`@signalTracking` and `@noSignalTracking` apply only to their owning function; they do
not affect nested functions. The plugin never adds a second `useSignalTracking()`
call: a direct, namespace, or barrel-imported call it finds is treated as the
function's existing opt-in. A call that is not the function's first statement,
and any barrel-imported call, is left alone in both transform modes. A
first-statement call imported directly or as a namespace from `importSource` is
left in place under `"inject"`, but under `"managed"` (the default) it is
absorbed into the generated capture: the statement is removed and replaced by
the top-level capture Hook, and statically proven reads are wrapped at their
execution sites.

A first-statement `useSignalTracking()` call inside an `async` or generator function
fails the build under the default `"managed"` transform, with
`useSignalTracking transform only supports synchronous, non-generator functions`. That
combination is already invalid React — hooks require a synchronous function
component — so prefer fixing the function; `transform: "inject"` accepts it
without rewriting the function, if the file must keep building unchanged.

Parameter defaults are evaluated before the function body runs, so a signal
read in one — `function Label({ v = count.value })` — would happen before the
boundary opens and never be tracked. When a transformed function has such a
parameter, that parameter and every parameter after it (to keep their
evaluation order) are replaced by generated ones and bound again as the first
statements inside the boundary, with the same `undefined`-only default rule.
The parameter count is unchanged, so `forwardRef`'s `(props, ref)` shape is
kept. If the body declares a name a moved default refers to, or re-declares a
moved parameter, the move is skipped and that read stays untracked; read the
signal in the body instead.

The move keeps the default rule and the evaluation order. In TypeScript the
generated parameter keeps the original's type and optionality, so the output
stays valid TypeScript. The function's `length` can change, though. A
parameter with a default does not count toward `length`, but the generated
parameter that replaces it does. For example,
`function useLabel(prefix?: string, value = count.value)` has a `length` of 1
in the source and 2 after the transform. Do not rely on the `length` of a
transformed function.

## Build integration

Reapplying either transform mode is a no-op. The plugin is registered with
`enforce: "pre"` on bundlers that support it (Vite, webpack, Rspack), and under
Vite its transform hook also declares `order: "pre"` (see
[With React Compiler](#with-react-compiler)). Rollup has neither concept, so
list this plugin first there. Wherever the order of plugins or loaders is in
your hands, put this plugin before anything that runs React Compiler or
compiles JSX away. The transform skips dependencies and
non-JavaScript/TypeScript modules, and never touches `.cjs` / `.cts` modules.
The plugin matches extensions case-insensitively, so it transforms `App.TSX`
exactly like `App.tsx`. Whether the bundler then compiles such a file the same
way is up to the bundler, and is not guaranteed: Vite 8 does not compile
`.JSX` / `.TSX` as JSX / TSX and fails to parse them, with or without this
plugin. Plain `.ts` files are parsed as TypeScript without JSX, while `.tsx`,
`.jsx`, and JavaScript files may use JSX.

## Fast Refresh

Managed output now calls `useSignalCapture()` at the top level of each transformed function and wraps statically proven synchronous reads in short capture scopes. Authored Hooks remain in the function body at the same top-level positions; generated output contains no `try/finally` around user code. The per-read runtime restores its scope if a captured expression throws, and uncommitted render attempts never install subscriptions.

The previous managed `try/finally` structure was the source of the Vite 8 / Oxc Fast Refresh Hook-signature issue described in the historical qualification record. The current output passed the real-browser Vite 8/Oxc HMR cases for JSX-only edits and Hook addition, removal, and reordering; all six hook-shape cases passed under managed Oxc and Babel. The full six-variant matrix completed 18 passes; the six known failures remain limited to the ordinary React `try/finally` control and Preact's corresponding Oxc structure. This closes the HMR subgate. The supported exactness contract remains limited to statically identified synchronous reads; unsupported callback ownership, destructuring variants, and dynamic-selection cases are migration constraints, and a stale render in a supported pattern is a bug.

`transform: "inject"` continues to insert a bare `useSignalTracking()` Hook and provides a best-effort ambient boundary. Managed mode retains implicit signal read detection for its documented static synchronous scope while tracking each selected expression in isolation; unsupported callback ownership and dynamic patterns are documented and warned where statically provable.

## React Server Components

The transform does not infer server/client identity from bundler environment
or layer. A module with a module-level `"use server"` directive is left
untransformed, with a source-located warning when a JSX-returning candidate is
found. A module-level `"use client"` continues through the normal transform.
Server Components without either directive cannot be identified by a
single-file transform, so a synchronous component that reads `.value` may
still receive the client-only render-tracking hook (async functions are not
transformed). In an RSC setup, keep server components out of the transform with
`exclude`, opt individual ones out with a `@noSignalTracking` comment, or use
`mode: "manual"`.

## License

MIT © akazawa. See [LICENSE](LICENSE).
