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

If your build runs React Compiler and you call the bare `useSignalTracking()` hook by hand (imported directly from the package), add `"use no memo"` to your component: the compiler otherwise caches the component's JSX and never re-reads `signal.value`, so the component stops updating without any error. The build plugin inserts that directive for transformed functions. See [the React Compiler compatibility note](../../development/design/react-compiler-compatibility.md).

Synchronous signal reads made during the render after `useSignalTracking()` are collected, and a change to one of those values schedules a rerender of that component. With `deepSignal`, property reads are tracked individually, so an unread sibling does not cause a rerender. This is the simplest option when you want explicit control and no build configuration.

The bare runtime boundary is best-effort: tracking closes at the next `useSignalTracking()` call, when React starts committing (before any layout effect or ref callback), or in a microtask scheduled after the current synchronous execution. Every component that reads a signal during render must call `useSignalTracking()` itself; reads from effects, event handlers, asynchronous callbacks, or an untracked component can otherwise be attributed to the currently open boundary. The managed transform instead installs a top-level `useSignalCapture()` Hook and captures statically proven synchronous reads at their execution sites. Its supported patterns and diagnostics are listed in the [managed tracking contract](../../packages/unplugin-react-fine-grained-signals/README.md#managed-tracking-contract). `useManagedSignals` was removed in v0.4; see [the migration note](./hooks.md#migrating-from-usemanagedsignals).

The custom JSX runtime provides a second, independent optimization: a signal used as a native host child or an allowlisted host prop updates as a local DOM leaf, without rerendering the parent component at all. See [JSX signal children and host bindings](./jsx-bindings.md) for the full allowlist, coercion rules, and caveats.

## With a plugin: managed or injected tracking

With the plugin in the build, `mode: "auto"` (the default) finds eligible components and custom hooks from statically recognized `.value` reads. This is a selection rule, not whole-function dependency discovery: destructured signal accessors and reads hidden behind dynamic keys alone do not select a function.

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

- **`mode`**: how components opt in. Choose `"auto"` (default) for automatic detection of components that read `.value`, `"manual"` for explicit opt-in via a `useSignalTracking()` call or `@signalTracking` annotation, or `"all"` to select every eligible JSX component.
- **`transform`**: how opted-in functions track signal reads. Choose `"managed"` (default) for top-level capture and per-read scopes on statically proven synchronous reads, or `"inject"` for the same best-effort behavior as a bare `useSignalTracking()` hook written by hand.

The managed transform's capture scopes only see synchronous expressions that the build can identify and wrap. A `const { user: { profile } } = state.value; profile.name` pattern is supported when each key and binding is a static identifier, each pattern is a nonempty object pattern, no TypeScript annotations are present, and bindings are not reassigned. The transform evaluates the source and intermediate properties once in source order, then captures later reads such as `profile.name`. Other destructuring shapes (defaults, rest, computed keys, arrays, `let`, assignments, loop heads) are evaluated as authored inside one capture; only destructuring a signal accessor (`const { value } = count`) remains unsupported. A synchronous helper call may be captured at its call site when the selected transform can prove the call's execution; a helper imported from another module is not inspected for auto-selection. JSX render props, `children` callbacks, deferred work, and dynamic aliases have no general invocation guarantee, so heed source-located diagnostics and verify updates. An explicit first-statement `useSignalTracking()` is preserved in managed mode and keeps the runtime's ambient collection for reads without a `.value` expression, including deep proxy properties.

`mode: "auto"`, `"manual"`, and `"all"` decide which functions are selected. `auto` uses static reads, `manual` uses an explicit `useSignalTracking()` call or `@signalTracking`, and `all` selects eligible JSX components. They do not widen what a selected managed read can capture. Use `transform: "inject"` when you want ambient best-effort tracking inserted for selected functions.

One important caveat: when a first-statement `useSignalTracking()` call is imported via a barrel/re-export rather than directly from the package, the plugin cannot verify it is genuine, so it leaves the call alone in both transform modes and emits a build warning that the authored call remains untouched. Import `useSignalTracking` directly from the package to avoid this warning.

For the full list of options, including `reactCompiler`, render-callback detection, memo/forwardRef recognition, and barrel-import handling, see [the plugin documentation](../../packages/unplugin-react-fine-grained-signals/README.md).

See also: [React hooks](./hooks.md), [JSX signal children and host bindings](./jsx-bindings.md).
