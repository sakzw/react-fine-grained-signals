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
useSignal<T>(initialValue: T): FormBindableSignal<T>
```

Keeps one signal for the component lifetime.

- `initialValue` is used on the first render only; later renders return the same signal.
- Reading `.value` during render requires [`useSignalTracking()`](#usesignaltracking) (or the plugin) in that same component.
- `useSignal()` returns `FormBindableSignal<T>`, which is also a writable `Signal<T>`. Keep this specific type when passing the value through a generic form component; annotating it as `Signal<T>` widens away the capability required by `bindValue` and `bindChecked`.

## useDeepSignal

```ts
useDeepSignal<T extends object>(initialValue: T | (() => T)): DeepSignal<T>
```

Keeps one deep signal, with property-level tracking, for the component lifetime.

- For an expensive initial value, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`.
- Properties read after [`useSignalTracking()`](#usesignaltracking) are tracked individually, so changing an unread sibling does not rerender the component.

## useComputed

```ts
useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>
useComputed<T>(options: WritableComputedOptions<T>, dependencies?: DependencyList): FormBindableSignal<T>
```

Creates a computed signal whose identity stays stable while its dependency array (if any) is unchanged. Pass a getter for a read-only computed, or `{ get, set }` for a writable computed. The writable overload returns `FormBindableSignal<T>` and can be passed to a matching `bindValue` or `bindChecked`; getter-only calls remain `ReadonlySignal<T>`. A component must keep to one of the two dependency modes and keep the call site's read-only or writable capability fixed for its lifetime.

- **Without a dependency array**, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- Fast Refresh preserves this Hook's state. If an edit changes a signal-only getter or writable setter while preserving the component, the retained computed can keep the pre-edit closure until that component remounts. Add `// @refresh reset` to the component during development when an edit must recreate it; this intentionally resets that component's local React state. This does not affect production behavior.
- **With a dependency array**, list every non-signal value the getter captures: `useComputed(() => count.value * step, [step])`.
- Keep the chosen mode and, when provided, the dependency array's length and order fixed. Switching omitted and explicit modes or changing its length throws before `useMemo` creates a replacement computed; React's warning-only length check can otherwise preserve the old computed closure.

The `{ get, set }` overload follows the same dependency rules. When dependencies change, the render creates a separate computed with the new getter and setter, so the returned signal's identity changes; the previous signal keeps its own callbacks. For form binding, the getter is the displayed value: if the setter rejects or normalizes input, the binding restores the getter result after React has observed the user event.

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

A capture or managed scope opened while a `useSignalTracking()` window is open suspends that window and gives it back. Reads inside the nested scope (a `useSignalCapture()` / `capture()` call, or a hand-written `useManagedSignals()` ... `finish()` custom Hook) are attributed to that scope, and reads after it returns, in the same component function, go to the component's window again. React exposes no component identity, so a window a previous sibling left open is suspended the same way rather than closed: until it closes, it can collect a later component's uncaptured reads. That can cause an extra render of the sibling, never a missed update.

That is why every reading component needs its own call: a read from a sibling or descendant that does not call `useSignalTracking()` can be attributed to another component's still-open window, and that signal then silently stops updating the component that actually read it.

Use the build plugin's `transform: "managed"` (its default) for statically proven synchronous reads. It installs a top-level capture Hook and wraps individual reads, so authored Hooks remain at their normal top level. The supported patterns and diagnostics are listed in the [managed tracking contract](../../packages/unplugin-react-fine-grained-signals/README.md#managed-tracking-contract).

### Exact boundary without the plugin

`react-fine-grained-signals/runtime` exports `useManagedSignals`, which returns a scope handle that you close yourself with a `try` / `finally`. This manual form provides a lexical boundary without a build transform.

```tsx
import { useManagedSignals } from "react-fine-grained-signals/runtime";

function Row() {
  const store = useManagedSignals();
  try {
    // signal reads
  } finally {
    store.finish();
  }
}
```

- The runtime scope closes exactly where `finally` runs and can collect any synchronous signal read executed inside it, including reads inside a helper called synchronously.
- This lexical scope is not equivalent to the plugin's current `transform: "managed"` output. The plugin uses a top-level `useSignalCapture()` Hook and wraps only reads it can prove are synchronous at their execution sites. A helper-only or dynamically selected read may therefore be missed; consult the plugin guide before migrating an existing boundary.

### React Compiler

The runtime-import boundary above is not the silent-freeze hazard that a bare `useSignalTracking()` is. Measured against `babel-plugin-react-compiler` 1.0.0, the compiler cannot lower `try` without `catch`, so it abandons the function, emits it unchanged, and the component keeps updating on every write — with or without `"use no memo"`.

What the directive buys is the build, not the runtime: under `panicThreshold: "all_errors"` the same bail-out is fatal without it and merely logged with it. The build plugin adds the directive to its own `managed` output automatically (`reactCompiler: "auto"`, the default) but leaves a hand-written runtime-import boundary untouched. Write it by hand if your build panics on all errors, and for forward compatibility, since the bail-out is a compiler limitation rather than a guarantee.

See [the React Compiler compatibility note](../../development/design/react-compiler-compatibility.md) and [the boundary design note](../../development/design/use-signals-boundary-design.md) for the full analysis.

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T // a deepSignal is rejected at compile time
```

Subscribes to a single signal and returns its current value. This is the low-level explicit leaf subscription, for when you want one named subscription instead of a component-wide `useSignalTracking()` window.

- It follows replacement of the signal's value only. A `deepSignal` is rejected by its type, because nested mutations would never re-render; use [`useDeepSignalValue`](#usedeepsignalvalue) to select from deep state.

## useDeepSignalValue

```ts
useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T>,
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

- Omitting `dependencies` retains the initial selector closure. Use this when the selector reads only signal state; props, React state, and other captured values are not automatically tracked.
- Pass `[]` to choose an explicit empty dependency array, or list every captured non-signal value (for example `[prefix]`) so the selector updates with it. Omitted and explicit modes cannot be switched at the same call site during the component's lifetime.
- An explicit dependency array must keep a constant length and order. A length change between renders throws.
- The selector must return a primitive snapshot. Object, Proxy, and function results are rejected at runtime with a `TypeError` because mutable results do not provide stable snapshot identity.

See also: [core primitives](./core-primitives.md), [rendering optimization](./rendering-optimization.md).
