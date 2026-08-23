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

`useSignal` and `useDeepSignal` keep one signal for the component lifetime. For expensive deep initial values, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`. Deep properties read after `useSignals()` are tracked individually, so changing an unread sibling does not rerender the component. `useSignalValue` remains available as a low-level explicit leaf subscription. Use `useDeepSignalValue(state, value => value.user.name, [])` when an explicit primitive selector is preferable; its dependency array is required, must keep a constant length and order, and must list every non-signal value captured by the selector. Object, Proxy, and function selector results are rejected at runtime with a `TypeError`; selectors must return primitive snapshots. `useSignalEffect` starts its effect after commit and disposes it during unmount (including Strict Mode replay). Without a dependency array, its callback must read only signals and its initial closure is retained for the component lifetime. When it captures props, state, or another non-signal value, list those values in the optional dependency array: `useSignalEffect(() => { /* read signals and props */ }, [prop])`.

`useComputed` has two modes:

- Without a dependency array, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- When the getter captures non-signal values, list every such value in the dependency array: `useComputed(() => count.value * step, [step])`. Choose one mode for a component's lifetime.

See also: [core primitives](core-primitives.md), [rendering optimization](rendering-optimization.md).
