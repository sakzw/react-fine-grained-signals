# Core primitives

[English](core-primitives.md) | [日本語](core-primitives.ja.md)

```ts
import { batch, computed, effect, signal, untracked } from "react-fine-grained-signals";

const count = signal(0);
const doubled = computed(() => count.value * 2);

const dispose = effect(() => {
  console.log(doubled.value);
});

batch(() => {
  count.value = 1;
  count.value = 2;
});

const current = untracked(() => count.value);
dispose();
```

`signal` creates a writable `Signal<T>`; `computed` creates a read-only `ReadonlySignal<T>`. Both expose `.value` and `.peek()`. Writes use `Object.is` equality, and effects return a disposer; an effect's returned cleanup is run before its next execution and when disposed.

If a `computed` getter throws, the write that triggered re-evaluation still completes normally; the error is cached and rethrown from `.value` and `.peek()` on the next read of that computed instead, so a `useSignalValue`/`useSignals()` read of it during React's render reaches an Error Boundary. A later write to a dependency the getter did read before failing correctly triggers re-evaluation on the next read, so the computed recovers once its inputs make the getter succeed again; a dependency the getter never reached because it threw first is not tracked, so a write to only that dependency does not by itself trigger re-evaluation.

## Deep signals

`deepSignal` adds property-level tracking for plain objects and arrays. Proxies are created lazily and cached, so aliases and cycles retain stable identity.

```ts
import { computed, deepSignal } from "react-fine-grained-signals";

const state = deepSignal({
  user: { profile: { name: "Alice" } },
  items: ["first"],
});
const name = computed(() => state.value.user.profile.name);

state.value.user.profile.name = "Bob";
state.value.items.push("second");
```

Only assignment, deletion, and standard array mutations made through `state.value` are observable. `state.peek()` returns the untracked raw root and should be used for reads only. The root must be a mutable plain object or array containing data properties; accessor properties, descriptor/prototype changes, and `freeze`/`seal` are rejected in v1. Nested plain objects and arrays are reactive; class instances, functions, `Date`, `Map`, `Set`, promises, and existing signals are treated as opaque values. Non-extensible objects are rejected rather than made partially reactive.

Only an opaque `Map` or `Set` reached directly from a reactive plain-object or array proxy is exposed through `state.value` as a read-only view. Its TypeScript type remains the mutable native `Map` or `Set` type for `Signal<T>` compatibility, but mutation methods throw at runtime: `set`, `add`, `delete`, and `clear` are not allowed. Create a new `Map` or `Set`, change that copy, and assign it back instead.

This view guarantee does not cross an opaque boundary. Class instances, `Date`, functions, collection entries, accessor results, prototype state, private fields, closure state, `WeakMap` entries, and Promise internals are raw, non-reactive regions; values obtained through those regions, and opaque values mutated after they are stored, are not protected from direct mutation. To avoid invoking user code, write validation inspects only own data descriptors and `Map` / `Set` entries; it never calls getters or setters and cannot inspect the other internal regions above. Such writes are rejected when those inspected values contain library proxies.

## Identifying signals

`isSignal(value)` reports whether a value came from `signal`, `computed`, or `deepSignal`. The custom JSX runtime and the control-flow components route on it, so a false negative degrades a reactive binding into a plain prop instead of raising an error.

Identification therefore has to work across package instances. Every signal carries a non-enumerable brand under `Symbol.for("react-fine-grained-signals.signal")` whose value is the protocol version, currently `1`, and `isSignal` accepts any value carrying a supported version that also exposes `peek()`. A duplicate copy of the package — pnpm hoisting differences, a monorepo consumer, an ESM/CJS split — or a signal that crossed a realm boundary is still recognized. The brand stays out of `Object.keys`, `JSON.stringify`, object spread, and React's prop diffing.

This fixes identification only. Reactivity additionally requires a shared `alien-signals` instance, because dependency tracking lives in that module's global state; see [Packaging](../README.md#packaging) for why it is a peer dependency. A recognized foreign signal reads correctly, but it propagates updates only while the reactive core underneath is shared.

Assigning the brand into `deepSignal` state throws, because a branded subtree would read as a signal and stop being made reactive.

See also: [React hooks](hooks.md), [rendering optimization](rendering-optimization.md).
