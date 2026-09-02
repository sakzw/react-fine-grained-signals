# Rendering optimization

[English](rendering-optimization.md) | [日本語](rendering-optimization.ja.md)

There are two separate optimization layers. They can be used independently:

1. The runtime hooks and JSX runtime work without a build plugin.
2. The optional `unplugin-react-fine-grained-signals` package inserts `useSignals()` around selected components and custom hooks, wrapped by default in an exact managed boundary.

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

If your build runs React Compiler and you call the bare `useSignals()` hook by hand (imported directly from the package), add `"use no memo"` to your component: the compiler otherwise caches the component's JSX and never re-reads `signal.value`, so the component stops updating without any error. The build plugin below inserts that directive for you. Note: the hand-written managed boundary pattern (`import { useSignals } from "react-fine-grained-signals/runtime"` with `try`/`finally`) does not need this directive — see [the React Compiler compatibility note](design/react-compiler-compatibility.md) for details.

Synchronous signal reads made during the render after `useSignals()` are collected, and a change to one of those values schedules a rerender of that component. With `deepSignal`, property reads are tracked individually, so an unread sibling does not cause a rerender. This is the simplest option when you want explicit control and no build configuration.

The bare runtime boundary is best-effort: tracking closes at the next `useSignals()` call, at the commit-phase layout effect, or in a microtask scheduled after the current synchronous execution. It is intended for synchronous component renders. Every component that reads a signal during render must call `useSignals()` itself; reads from effects, event handlers, asynchronous callbacks, or an untracked component can otherwise be attributed to the currently open boundary. Exact separation across Suspense-aborted renders, nested server rendering during a render, and multiple concurrent roots requires an exact `try`/`finally` boundary that closes synchronously when the component returns, rather than this best-effort window. The managed transform below generates that boundary automatically; the same boundary is also reachable by hand with `import { useSignals } from "react-fine-grained-signals/runtime"` (see [the tracking boundary note](hooks.md)) — the plugin is simply the lower-boilerplate route, with no hand-written `try`/`finally` to forget. The unresolved boundary problem and the options for a future contract are tracked in [the boundary design note](design/use-signals-boundary-design.md).

The custom JSX runtime provides a second, independent optimization: a signal used as a native host child or an allowlisted host prop updates as a local DOM leaf, without rerendering the parent component at all. See [JSX signal children and host bindings](jsx-bindings.md) for the full allowlist, coercion rules, and caveats.

## With a plugin: automatic `useSignals()` insertion

With the plugin in the build, components no longer call `useSignals()` by hand: in `mode: "auto"` (the default) the plugin finds every component and custom hook that reads `.value` and inserts the boundary itself.

The optional universal build plugin keeps Babel private: configure the integration for your bundler instead of adding a Babel config. By default it detects selected functions and wraps each in an exact `try` / `finally` render boundary, closing the tracking window synchronously at the point the component function returns. Choose `transform: "inject"` to instead insert a bare `useSignals()` call as the first hook — the same best-effort boundary as writing the hook yourself, without a control-flow rewrite. The JSX runtime's native leaf bindings work independently of the plugin.

```sh
pnpm add -D unplugin-react-fine-grained-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-fine-grained-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

The same package provides `/rollup`, `/webpack`, `/rspack`, and `/esbuild` entry points. It is ESM-only, so use `import` in the bundler configuration.

Two main options control the plugin:

- **`mode`**: how components opt in. Choose `"auto"` (default) for automatic detection of components that read `.value`, or `"manual"` for explicit opt-in via a `useSignals()` call or `@useSignals` annotation.
- **`transform`**: how opted-in functions are wrapped. Choose `"managed"` (default) for an exact render boundary, or `"inject"` for the same best-effort behavior as a bare `useSignals()` hook written by hand.

One important caveat: when a first-statement `useSignals()` call is imported via a barrel/re-export rather than directly from the package, the plugin cannot verify it is genuine, so it leaves the call alone in both transform modes and emits a build warning that the component is left on the best-effort/bare boundary (not absorbed into the managed/verified boundary). Import `useSignals` directly from the package (or from `/runtime` for an exact boundary) to avoid this warning.

For the full list of options, including `reactCompiler`, render-callback detection, memo/forwardRef recognition, and barrel-import handling, see [the plugin documentation](../packages/unplugin-react-fine-grained-signals/README.md).

See also: [React hooks](hooks.md), [JSX signal children and host bindings](jsx-bindings.md).
