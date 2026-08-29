# React hooks

[English](hooks.md) | [日本語](hooks.ja.md)

```tsx
import { useComputed, useSignal, useSignalEffect, useSignals } from "react-alien-signals";

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

Call `useSignals()` once and unconditionally as the first hook in every component that reads signal `.value` during render. It takes no arguments and returns no value. Synchronous signal reads after the hook are collected automatically, and the component rerenders when one of those values changes.

**Tracking boundary:** `useSignals()` is best-effort. Its collection window closes at the next `useSignals()` call, at the commit-phase layout effect, or in a microtask after the current synchronous execution — not at the point the component returns. Every component that reads a signal during render must call `useSignals()` itself: a read from a sibling or descendant component that does not call it can be attributed to another component's still-open window, and that signal then silently stops updating the component that actually read it. Use the build plugin's `transform: "managed"` (its default) when an exact boundary is required — it needs no manual `try`/`finally`, so it's the least error-prone option when available. Without it, `import { useSignals } from "react-alien-signals/runtime"` (a different function from the same-named export at the package root) returns the same handle directly: `const store = useSignals(); try { /* reads */ } finally { store.f(); }` gives the identical exact boundary with no build-time transform. Under React Compiler, this hand-written pattern is not the silent-freeze hazard that a bare `useSignals()` is: measured against `babel-plugin-react-compiler` 1.0.0, the compiler cannot lower `try` without `catch`, so it abandons the function, emits it unchanged, and the component keeps updating on every write — with or without `"use no memo"`. What the directive buys is the build, not the runtime: under `panicThreshold: "all_errors"` the same bail-out is fatal without it and merely logged with it. The build plugin adds the directive to its own `managed` output automatically (`reactCompiler: "auto"`, the default) but leaves a hand-authored runtime-import component untouched, so write it by hand if your build panics on all errors — and for forward compatibility, since the bail-out is a compiler limitation rather than a guarantee. See [the React Compiler compatibility note](design/react-compiler-compatibility.md). See [the boundary design note](design/use-signals-boundary-design.md) for the full analysis.

`useSignal` and `useDeepSignal` keep one signal for the component lifetime. For expensive deep initial values, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`. Deep properties read after `useSignals()` are tracked individually, so changing an unread sibling does not rerender the component. `useSignalValue` remains available as a low-level explicit leaf subscription. Use `useDeepSignalValue(state, value => value.user.name, [])` when an explicit primitive selector is preferable; its dependency array is required, must keep a constant length and order, and must list every non-signal value captured by the selector. Object, Proxy, and function selector results are rejected at runtime with a `TypeError`; selectors must return primitive snapshots. `useSignalEffect` starts its effect after commit and disposes it during unmount (including Strict Mode replay). Without a dependency array, its callback must read only signals and its initial closure is retained for the component lifetime. When it captures props, state, or another non-signal value, list those values in the optional dependency array: `useSignalEffect(() => { /* read signals and props */ }, [prop])`.

`useComputed` has two modes:

- Without a dependency array, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- When the getter captures non-signal values, list every such value in the dependency array: `useComputed(() => count.value * step, [step])`. Choose one mode for a component's lifetime.

See also: [core primitives](core-primitives.md), [rendering optimization](rendering-optimization.md).
