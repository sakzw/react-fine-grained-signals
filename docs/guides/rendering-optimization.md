# Rendering optimization

[English](./rendering-optimization.md) | [日本語](./rendering-optimization.ja.md)

There are two separate optimization layers. They can be used independently:

1. The runtime hooks and JSX runtime work without a build plugin.
2. The optional `unplugin-react-fine-grained-signals` package inserts a top-level capture Hook and per-read scopes into selected components and custom hooks.

Neither layer makes every React component signal-driven. React still owns the component tree and scheduling; the optimization narrows the work caused by signal changes to the component or native DOM leaf that actually read the signal.

## Without a plugin: explicit live tracking

Use `useSignalTracking()` when you want the live-library style without changing the build. It must be the first hook and must be called unconditionally:

```tsx
function Counter() {
  useSignalTracking();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

If your build runs React Compiler and you call the bare `useSignalTracking()` hook by hand (imported directly from the package), add `"use no memo"` to your component: the compiler otherwise caches the component's JSX and never re-reads `signal.value`, so the component stops updating without any error. The build plugin inserts that directive for transformed functions. A hand-written managed boundary (`useManagedSignals()` inside `try` / `finally`) also needs compiler protection; see [the React Compiler compatibility note](../../development/design/react-compiler-compatibility.md).

Synchronous signal reads made during the render after `useSignalTracking()` are collected, and a change to one of those values schedules a rerender of that component. With `deepSignal`, property reads are tracked individually, so an unread sibling does not cause a rerender. This is the simplest option when you want explicit control and no build configuration.

The bare runtime boundary is best-effort: tracking closes at the next `useSignalTracking()` call, when React starts committing (before any layout effect or ref callback), or in a microtask scheduled after the current synchronous execution. Every component that reads a signal during render must call `useSignalTracking()` itself; reads from effects, event handlers, asynchronous callbacks, or an untracked component can otherwise be attributed to the currently open boundary. The managed transform instead installs a top-level `useSignalCapture()` Hook and captures statically proven synchronous reads at their execution sites. Its coverage and diagnostics are listed in the [plugin guide](../../packages/unplugin-react-fine-grained-signals/README.md#fast-refresh). The manual `useManagedSignals()` plus `try` / `finally` pattern remains available for explicit lexical ownership (see [the tracking boundary note](./hooks.md#exact-boundary-without-the-plugin)).

The custom JSX runtime provides a second, independent optimization: a signal used as a native host child or an allowlisted host prop updates as a local DOM leaf, without rerendering the parent component at all. See [JSX signal children and host bindings](./jsx-bindings.md) for the full allowlist, coercion rules, and caveats.

## With a plugin: automatic `useSignalTracking()` insertion

With the plugin in the build, components no longer call `useSignalTracking()` by hand: in `mode: "auto"` (the default) the plugin finds every component and custom hook that reads `.value` and inserts the boundary itself.

The optional universal build plugin keeps Babel private: configure the integration for your bundler instead of adding a Babel config. By default it detects selected functions and adds a top-level capture Hook, wrapping statically proven synchronous reads in short capture scopes. Choose `transform: "inject"` to instead insert a bare `useSignalTracking()` call as the first hook — the same best-effort boundary as writing the hook yourself, without per-read rewriting. The JSX runtime's native leaf bindings work independently of the plugin.

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

The same package provides `/rollup`, `/webpack`, `/rspack`, and `/esbuild` entry points. It ships ESM only; use `import` in an ESM bundler configuration. A CommonJS configuration file can still `require()` it through Node's `require(esm)` support — see the [plugin README](../../packages/unplugin-react-fine-grained-signals/README.md#installation).

Two main options control the plugin:

- **`mode`**: how components opt in. Choose `"auto"` (default) for automatic detection of components that read `.value`, or `"manual"` for explicit opt-in via a `useSignalTracking()` call or `@signalTracking` annotation.
- **`transform`**: how opted-in functions track signal reads. Choose `"managed"` (default) for top-level capture and per-read scopes on statically proven synchronous reads, or `"inject"` for the same best-effort behavior as a bare `useSignalTracking()` hook written by hand.

One important caveat: when a first-statement `useSignalTracking()` call is imported via a barrel/re-export rather than directly from the package, the plugin cannot verify it is genuine, so it leaves the call alone in both transform modes and emits a build warning that the authored call remains untouched. Import `useSignalTracking` directly from the package to avoid this warning.

For the full list of options, including `reactCompiler`, render-callback detection, memo/forwardRef recognition, and barrel-import handling, see [the plugin documentation](../../packages/unplugin-react-fine-grained-signals/README.md).

See also: [React hooks](./hooks.md), [JSX signal children and host bindings](./jsx-bindings.md).
