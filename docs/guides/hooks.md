# React hooks

[English](./hooks.md) | [日本語](./hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignalTracking } from "react-fine-grained-signals";

function Counter({ step }: { step: number }) {
  useSignalTracking();
  const count = useSignal(0);
  const scaled = useComputed(() => count.value * step, [step]);

  useSignalEffect(() => {
    console.log("count:", count.value);
  });

  return <button onClick={() => (count.value += step)}>{scaled.value}</button>;
}
```

## useSignal

```ts
useSignal<T>(initialValue: T): Signal<T>
```

Keeps one signal for the component lifetime.

- `initialValue` is used on the first render only; later renders return the same signal.
- Reading `.value` during render requires [`useSignalTracking()`](#usesignaltracking) (or the plugin) in that same component.
- `useSignal()` returns a writable `Signal<T>`, which works directly with `bindValue` and `bindChecked`. `Signal<T>` is invariant in `T`, so annotate it with the exact value type rather than a wider one.

## useDeepSignal

```ts
useDeepSignal<T extends object>(initialValue: PlainRoot<T> | (() => PlainRoot<T>)): DeepSignal<T> // PlainRoot rejects a Map, Set, WeakMap or WeakSet root
```

Keeps one deep signal, with property-level tracking, for the component lifetime.

- For an expensive initial value, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`.
- Properties read after [`useSignalTracking()`](#usesignaltracking) are tracked individually, so changing an unread sibling does not rerender the component.

## useComputed

```ts
useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>
```

Creates a read-only computed signal whose identity stays stable while its dependency array (if any) is unchanged. For a writable computed, use [`useWritableComputed`](#usewritablecomputed).

- **Omitting `dependencies` is the same as passing `[]`.** The getter must read only signals. Its computed identity stays stable across ordinary renders, so it must not capture props, React state, or other non-signal values.
- Fast Refresh may recreate this memoized computed after an edit, so updated getters take effect while React component state is preserved. This is development behavior; production identity remains stable across ordinary renders.
- **To capture a non-signal value**, list it: `useComputed(() => count.value * step, [step])`.
- Keep the array's length and order fixed. A length change, including switching between omitted (or `[]`) and a non-empty list, throws before `useMemo` creates a replacement computed; React's warning-only length check can otherwise preserve the old computed closure.

## useWritableComputed

```ts
useWritableComputed<T>(options: WritableComputedOptions<T>, dependencies?: DependencyList): Signal<T>
```

Creates a writable computed signal from `{ get, set }`. It returns `Signal<T>`, so it can be passed to a matching `bindValue` or `bindChecked`. The dependency rules are those of `useComputed`: omitting `dependencies` is the same as `[]`, and `get` and `set` must list any non-signal value they capture. When dependencies change, the render creates a separate computed with the new getter and setter, so the returned signal's identity changes; the previous signal keeps its own callbacks. For form binding, the getter is the displayed value: if the setter rejects or normalizes input, the binding restores the getter result after React has observed the user event.

## useSignalEffect

```ts
useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void
```

Starts an effect after commit and disposes it on unmount, including Strict Mode replay.

- Omitting dependencies and passing `[]` are equivalent for this hook: both retain the initial callback and do not reconnect on ordinary React renders. This differs from calling React's `useEffect` directly without dependencies, which runs after every commit. The two forms can be switched during the component lifetime.
- When the callback captures props, state, or another non-signal value, list those values: `useSignalEffect(() => { /* reads signals and props */ }, [prop])`. Changes at the same dependency positions clean up the previous effect and connect the new callback.
- Keep the dependency array's length and order fixed. A length change, including switching between an empty and non-empty list, throws before React can warn and retain a stale callback.
- A function returned from the callback is its cleanup, run before the next execution and on disposal.

## useSignalTracking

```ts
useSignalTracking(): void
```

Opens the render-tracking window. Call it once and unconditionally as the first hook in every component that reads signal `.value` during render.

With the build plugin, `mode: "auto"` selects eligible functions from statically recognized `.value` reads and uses managed per-read capture. Write this call yourself when you build without the plugin, when you use `mode: "manual"`, or when a managed component needs ambient collection for deep-proxy properties such as `task.done`. The plugin preserves a directly imported, first-statement call even in `transform: "managed"`. See [Rendering optimization](./rendering-optimization.md) for the two layers side by side.

- It takes no arguments and returns no value.
- Synchronous signal reads after the call are collected automatically, and the component rerenders when one of those values changes.
- With `deepSignal`, property reads are tracked individually, so changing an unread sibling property does not rerender the component.
- Every component that reads a signal during render must call it itself. The window is not inherited from a parent.
- The boundary is best-effort. Read [Tracking boundary](#tracking-boundary) before relying on it outside a synchronous component render.

### Tracking boundary

The collection window closes at the next `useSignalTracking()` call, when React starts committing (before any layout effect or ref callback runs), or in a microtask after the current synchronous execution — not at the point the component returns. Reads outside an open window, including the layout effects and refs of the component's own descendants, are ordinary reactive reads.

A capture scope opened while a `useSignalTracking()` window is open suspends that window and gives it back. Reads inside the nested scope (the build plugin's `useSignalCapture()` / `capture()` calls) are attributed to that scope, and reads after it returns, in the same component function, go to the component's window again. React exposes no component identity, so a window a previous sibling left open is suspended the same way rather than closed: until it closes, it can collect a later component's uncaptured reads. That can cause an extra render of the sibling, never a missed update.

That is why every reading component needs its own call: a read from a sibling or descendant that does not call `useSignalTracking()` can be attributed to another component's still-open window, and that signal then silently stops updating the component that actually read it.

Use the build plugin's `transform: "managed"` (its default) for statically proven synchronous reads. It installs a top-level capture Hook and wraps individual reads, so authored Hooks remain at their normal top level. The supported patterns and diagnostics are listed in the [managed tracking contract](../../packages/unplugin-react-fine-grained-signals/README.md#managed-tracking-contract).

### Migrating from `useManagedSignals`

v0.4 removes `useManagedSignals` and `ManagedSignalsStore` (`react-fine-grained-signals/internal` now holds only the build plugin's generated code). `useSignalTracking()` is the only tracking boundary you write yourself. If you closed a `useManagedSignals()` scope with `try` / `finally`, choose one of:

- the build plugin with `transform: "managed"` (the default), which captures statically proven synchronous reads;
- the leaf hooks `useSignalValue` and `useComputed`, which subscribe one component to one value;
- `useSignalTracking()`, with the best-effort limits described above.

### React Compiler

A bare `useSignalTracking()` needs `"use no memo"` when the build runs React Compiler; the build plugin adds the directive to the functions it transforms (`reactCompiler: "opt-out"`, the default). Without it the compiler caches the component's JSX and the component stops updating. See [Rendering optimization](./rendering-optimization.md).

See [the React Compiler compatibility note](../../development/design/react-compiler-compatibility.md) and [the boundary design note](../../development/design/use-signals-boundary-design.md) for the full analysis.

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T // a deepSignal is rejected at compile time
```

Subscribes to a single signal and returns its current value. This is the low-level explicit leaf subscription, for when you want one named subscription instead of a component-wide `useSignalTracking()` window.

- It follows replacement of the signal's value only. A `deepSignal` is rejected by its type, because nested mutations would never re-render; use [`useDeepSignalValue`](#usedeepsignalvalue) to select from deep state.
- `source` must be a signal or computed created by this package. Any other value, such as a plain `{ value }` object, throws a `TypeError` during render.

## useDeepCollectionSignal

```ts
useDeepCollectionSignal<T extends object>(initialValue: T | (() => T)): DeepCollectionSignal<T>
```

`useDeepSignal` with `Map`, `Set`, `WeakMap`, and `WeakSet` tracking (see [`deepCollectionSignal`](./core-primitives.md#deepcollectionsignal)). The identity and factory rules are the same as `useDeepSignal`. `useDeepSignal` does not track collections, so a `Map` or `Set` root is rejected.

## useDeepSignalValue

```ts
useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T> | DeepCollectionSignal<T>,
  selector: (value: T) => S,
  dependencies?: DependencyList,
): S
```

Subscribes to one primitive derived from a deep signal.

```tsx
const name = useDeepSignalValue(state, (value) => value.user.name);
const label = useDeepSignalValue(
  state,
  (value) => `${prefix}: ${value.user.name}`,
  [prefix],
);
```

- Omitting `dependencies` is the same as passing `[]`: the initial selector closure is retained. Use this when the selector reads only signal state; props, React state, and other captured values are not automatically tracked.
- To capture a non-signal value, list every captured value (for example `[prefix]`) so the selector updates with it.
- The dependency array must keep a constant length and order. A length change between renders, including switching between omitted (or `[]`) and a non-empty list, throws.
- The selector must return a primitive snapshot. Object, Proxy, and function results are rejected at runtime with a `TypeError` because mutable results do not provide stable snapshot identity.

See also: [core primitives](./core-primitives.md), [rendering optimization](./rendering-optimization.md).
