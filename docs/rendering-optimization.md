# Rendering optimization

[English](rendering-optimization.md) | [日本語](rendering-optimization.ja.md)

There are two separate optimization layers. They can be used independently:

1. The runtime hooks and JSX runtime work without a build plugin.
2. The optional `unplugin-react-alien-signals` package inserts `useSignals()` around selected components and custom hooks, wrapped by default in an exact managed boundary.

Neither layer makes every React component signal-driven. React still owns the component tree and scheduling; the optimization narrows the work caused by signal changes to the component or native DOM leaf that actually read the signal.

## Without a plugin: explicit live tracking

Use `useSignals()` when you want the live-library style without changing the build. It must be the first hook and must be called unconditionally:

```tsx
function Counter() {
  useSignals();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

If your build runs React Compiler, add `"use no memo"` to every component that calls `useSignals()` by hand: the compiler otherwise caches the component's JSX and never re-reads `signal.value`, so the component stops updating without any error. The build plugin below inserts that directive for you. See [the React Compiler compatibility note](design/react-compiler-compatibility.md).

Synchronous signal reads made during the render after `useSignals()` are collected, and a change to one of those values schedules a rerender of that component. With `deepSignal`, property reads are tracked individually, so an unread sibling does not cause a rerender. This is the simplest option when you want explicit control and no build configuration.

The bare runtime boundary is best-effort: tracking closes at the next `useSignals()` call, at the commit-phase layout effect, or in a microtask scheduled after the current synchronous execution. It is intended for synchronous component renders. Every component that reads a signal during render must call `useSignals()` itself; reads from effects, event handlers, asynchronous callbacks, or an untracked component can otherwise be attributed to the currently open boundary. Exact separation across Suspense-aborted renders, nested server rendering during a render, and multiple concurrent roots requires an exact `try`/`finally` boundary that closes synchronously when the component returns, rather than this best-effort window. The managed transform below generates that boundary automatically; the same boundary is also reachable by hand with `import { useSignals } from "react-alien-signals/runtime"` (see [the tracking boundary note](hooks.md)) — the plugin is simply the lower-boilerplate route, with no hand-written `try`/`finally` to forget. The unresolved boundary problem and the options for a future contract are tracked in [the boundary design note](design/use-signals-boundary-design.md).

The custom JSX runtime provides a second, independent optimization: a signal used as a native host child or an allowlisted host prop updates as a local DOM leaf, without rerendering the parent component at all. See [JSX signal children and host bindings](jsx-bindings.md) for the full allowlist, coercion rules, and caveats.

## With a plugin: automatic `useSignals()` insertion

The optional universal build plugin keeps Babel private: configure the integration for your bundler instead of adding a Babel config. By default it detects selected functions and wraps each in an exact `try` / `finally` render boundary, closing the tracking window synchronously at the point the component function returns. Choose `transform: "inject"` to instead insert a bare `useSignals()` call as the first hook — the same best-effort boundary as writing the hook yourself, without a control-flow rewrite. The JSX runtime's native leaf bindings work independently of the plugin.

```sh
# Planned package name — it is not published to npm yet.
pnpm add -D unplugin-react-alien-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

The same package provides `/rollup`, `/webpack`, `/rspack`, and `/esbuild` entry points. It is ESM-only, so use `import` in the bundler configuration. It is currently a private workspace package and is not published to npm; the install and configuration snippets document the intended release API.

`mode` chooses how components opt in:

- `"manual"`: transform an explicit first-statement imported `useSignals()` call, or a named component/custom hook marked with `@useSignals`. This preserves the explicit live-library style.
- `"auto"` (default): additionally transform named JSX components that read `.value`, and named `useX` custom hooks that read `.value`.
- `"all"`: additionally transform every named JSX component. Use it when a component should opt in even though the static `.value` check cannot see a direct read; arbitrary nested callbacks are not transform targets.

`transform` chooses how an opted-in function is generated: `managed` (default) adds an exact try/finally boundary; `inject` adds bare `useSignals()` for best-effort opt-in.

- `"managed"` (default): import from `react-alien-signals/runtime` and emit the exact `try` / `finally` scope, closing the render-tracking window synchronously at the point the component function returns. This covers exact separation across Suspense-aborted renders, nested server rendering during render, and concurrent roots without any extra configuration.
- `"inject"`: import normal `useSignals` from `react-alien-signals` and insert its call as the first hook. It does not emit `try` / `finally` or rewrite existing control flow, so it keeps the same best-effort boundary as calling the hook by hand — see [the boundary design note](design/use-signals-boundary-design.md) for the sibling-misattribution limitation this can expose.

```ts
// The default already emits the exact managed boundary; select "inject"
// only where the plugin-free best-effort behavior is explicitly wanted.
signals({ mode: "auto", transform: "inject" });
```

`reactCompiler` chooses whether the plugin protects what it transformed from React Compiler:

- `"auto"` (default): mark every transformed function with the `"use no memo"` directive. Without it, the compiler caches the component's JSX and stops re-reading `signal.value`, so the component silently freezes after its first update. The directive is inert when the compiler is not used.
- `"off"`: omit the directive. Choose it only when React Compiler is not in the build, or when the affected components were checked against [the React Compiler compatibility note](design/react-compiler-compatibility.md).

The cost of `"auto"` is that a transformed component is no longer memoized by the compiler. The leaf hooks (`useSignalValue`, `useDeepSignalValue`) and the JSX runtime's direct host bindings are compiler-safe and are never transformed, so components written that way keep the compiler's optimization.

`@useSignals` and `@noUseSignals` apply only to their owning function, not nested functions. Automatic modes support top-level declaration and arrow components, including named components wrapped with `memo` or `forwardRef`; arbitrary nested callbacks, class components, anonymous default exports, and async/generator functions are not automatic targets. A component that already calls `useSignals()` never receives a second call: `transform: "inject"` leaves the existing call in place, while `transform: "managed"` (the default) absorbs a first-statement call into the boundary it generates, rewriting that function body. Because of that rewrite, an explicit first-statement `useSignals()` call inside an `async` or generator function is a build error under the default, where `"inject"` left it alone. Reapplying either transform mode is a no-op. The `.value` check is intentionally heuristic, so `mode: "auto"` may add a harmless subscription to an object that is not a signal.

Choose the approach based on how much build-time automation you want:

| Goal | Recommended approach |
| --- | --- |
| No plugin or bundler integration | Call `useSignals()` explicitly; use the JSX runtime for native signal children and allowlisted props. |
| Automatic insertion with an exact managed render boundary | Use the plugin with `mode: "auto"` (the default) — `transform` also defaults to `"managed"`. |
| Automatic insertion with the normal best-effort `useSignals()` behavior instead of the managed boundary | Use `mode: "auto"` with `transform: "inject"`. |
| Explicit opt-in with an exact render boundary | Use `mode: "manual"`; `transform` already defaults to `"managed"`. |
| Broad migration or components whose reads are hidden from the heuristic | Use `mode: "all"`, then opt out individual functions with `@noUseSignals` where needed. |

The plugin is not required for the core primitives, hooks, or JSX signal bindings. It is a development/build-time convenience for inserting `useSignals()` behind an exact managed render boundary by default, or as a bare best-effort call when `transform: "inject"` is selected; it does not replace `useSignals()` semantics or expand the native host-prop allowlist.

See also: [React hooks](hooks.md), [JSX signal children and host bindings](jsx-bindings.md).
