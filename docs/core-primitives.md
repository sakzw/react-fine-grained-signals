# Core primitives

[English](core-primitives.md) | [日本語](core-primitives.ja.md)

```ts
import { batch, computed, effect, signal, untracked } from "react-alien-signals";

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

## Deep signals

`deepSignal` adds property-level tracking for plain objects and arrays. Proxies are created lazily and cached, so aliases and cycles retain stable identity.

```ts
import { computed, deepSignal } from "react-alien-signals";

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

See also: [React hooks](hooks.md), [rendering optimization](rendering-optimization.md).
