# React hooks

[English](hooks.md) | [日本語](hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignals } from "react-fine-grained-signals";

function Counter({ step }: { step: number }) {
  useSignals();
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
- Reading `.value` during render requires [`useSignals()`](#usesignals) (or the plugin) in that same component.

## useDeepSignal

```ts
useDeepSignal<T extends object>(initialValue: T | (() => T)): DeepSignal<T>
```

Keeps one deep signal, with property-level tracking, for the component lifetime.

- For an expensive initial value, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`.
- Properties read after [`useSignals()`](#usesignals) are tracked individually, so changing an unread sibling does not rerender the component.

## useComputed

```ts
useComputed<T>(getValue: () => T, dependencies?: DependencyList): ReadonlySignal<T>
```

Creates a computed signal with a stable identity. It has two modes, and a component must keep to one of them for its lifetime.

- **Without a dependency array**, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- **With a dependency array**, list every non-signal value the getter captures: `useComputed(() => count.value * step, [step])`.

## useSignalEffect

```ts
useSignalEffect(callback: () => void | (() => void), dependencies?: DependencyList): void
```

Starts an effect after commit and disposes it on unmount, including Strict Mode replay.

- Without a dependency array, the callback must read only signals; its initial closure is retained for the component lifetime.
- When it captures props, state, or another non-signal value, list those values: `useSignalEffect(() => { /* reads signals and props */ }, [prop])`.
- A function returned from the callback is its cleanup, run before the next execution and on disposal.

## useSignals

```ts
useSignals(): void
```

Opens the render-tracking window. Call it once and unconditionally as the first hook in every component that reads signal `.value` during render.

With the build plugin in your build you do not write this by hand: in its default `mode: "auto"` the plugin inserts the boundary into every component and custom hook that reads `.value`. Write the call yourself when you build without the plugin, or when you run the plugin in `mode: "manual"` and want to opt a component in explicitly. See [Rendering optimization](rendering-optimization.md) for the two layers side by side.

- It takes no arguments and returns no value.
- Synchronous signal reads after the call are collected automatically, and the component rerenders when one of those values changes.
- With `deepSignal`, property reads are tracked individually, so changing an unread sibling property does not rerender the component.
- Every component that reads a signal during render must call it itself. The window is not inherited from a parent.
- The boundary is best-effort. Read [Tracking boundary](#tracking-boundary) before relying on it outside a synchronous component render.

### Tracking boundary

The collection window closes at the next `useSignals()` call, at the commit-phase layout effect, or in a microtask after the current synchronous execution — not at the point the component returns.

That is why every reading component needs its own call: a read from a sibling or descendant that does not call `useSignals()` can be attributed to another component's still-open window, and that signal then silently stops updating the component that actually read it.

Use the build plugin's `transform: "managed"` (its default) when an exact boundary is required. It needs no hand-written `try` / `finally`, so it is the least error-prone option when available.

### Exact boundary without the plugin

`react-fine-grained-signals/runtime` exports a different function under the same `useSignals` name: it returns a scope handle that you close yourself, giving the identical exact boundary with no build-time transform.

```tsx
import { useSignals } from "react-fine-grained-signals/runtime";

function Row() {
  const store = useSignals();
  try {
    // signal reads
  } finally {
    store.f();
  }
}
```

- The window closes exactly where `finally` runs, matching the plugin's managed output.
- The same function is also exported as `useManagedSignals`. Import that name when you want the managed contract to read explicitly at the call site instead of through the ambiguous `useSignals` alias.

### React Compiler

The runtime-import boundary above is not the silent-freeze hazard that a bare `useSignals()` is. Measured against `babel-plugin-react-compiler` 1.0.0, the compiler cannot lower `try` without `catch`, so it abandons the function, emits it unchanged, and the component keeps updating on every write — with or without `"use no memo"`.

What the directive buys is the build, not the runtime: under `panicThreshold: "all_errors"` the same bail-out is fatal without it and merely logged with it. The build plugin adds the directive to its own `managed` output automatically (`reactCompiler: "auto"`, the default) but leaves a hand-written runtime-import boundary untouched. Write it by hand if your build panics on all errors, and for forward compatibility, since the bail-out is a compiler limitation rather than a guarantee.

See [the React Compiler compatibility note](design/react-compiler-compatibility.md) and [the boundary design note](design/use-signals-boundary-design.md) for the full analysis.

## useSignalValue

```ts
useSignalValue<T>(source: ReadonlySignal<T>): T
```

Subscribes to a single signal and returns its current value. This is the low-level explicit leaf subscription, for when you want one named subscription instead of a component-wide `useSignals()` window.

## useDeepSignalValue

```ts
useDeepSignalValue<T extends object, S extends SignalSnapshot>(
  source: DeepSignal<T>,
  selector: (value: T) => S,
  dependencies: DependencyList,
): S
```

Subscribes to one primitive derived from a deep signal.

```tsx
const name = useDeepSignalValue(state, (value) => value.user.name, []);
```

- `dependencies` is required, must keep a constant length and order, and must list every non-signal value the selector captures. A length change between renders throws.
- The selector must return a primitive snapshot. Object, Proxy, and function results are rejected at runtime with a `TypeError`.

See also: [core primitives](core-primitives.md), [rendering optimization](rendering-optimization.md).
