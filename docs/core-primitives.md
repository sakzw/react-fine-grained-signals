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

## signal

```ts
signal<T>(initialValue: T): Signal<T>
```

Creates a writable reactive value.

- `.value` reads and writes it; reading inside a tracked scope registers a dependency.
- `.peek()` reads the current value without registering one.
- Writes use `Object.is` equality, so assigning an equal value notifies nothing.

## computed

```ts
computed<T>(getter: () => T): ReadonlySignal<T>
```

Creates a lazily evaluated, read-only derived value. It exposes the same `.value` and `.peek()` as `signal`, and re-evaluates on the next read after a dependency its getter read has changed.

### When the getter throws

The write that triggered re-evaluation still completes normally. The error is cached and rethrown from `.value` and `.peek()` on the next read of that computed instead, so a `useSignalValue`/`useSignals()` read of it during React's render reaches an Error Boundary.

A later write to a dependency the getter did read before failing correctly triggers re-evaluation on the next read, so the computed recovers once its inputs make the getter succeed again. A dependency the getter never reached because it threw first is not tracked, so a write to only that dependency does not by itself trigger re-evaluation.

## effect

```ts
effect(fn: () => void | (() => void)): () => void
```

Runs `fn` immediately, then again whenever a signal it read changes. Returns a disposer.

- A function returned from `fn` is its cleanup, run before the next execution and when the effect is disposed.
- A thrown error is contained rather than propagated to the write that triggered the run.

### Error containment

If an `effect()` callback throws — either its body or the cleanup function it returned — the error does not propagate to the write that triggered the run. The containment is required rather than cosmetic: `alien-signals` abandons the rest of its effect queue once an effect throws, so an escaping error would silently cancel every effect still queued behind it in that flush and then surface out of whatever event handler performed the write. Instead only the failing effect is skipped; every other effect in that flush still runs, and the failing effect keeps reacting to later writes. A cleanup that throws is contained the same way and does not prevent the effect's body from re-running.

The error is always reported, never swallowed. `console.error` receives `"react-fine-grained-signals: an effect() callback threw; the error is contained and reported here so this flush can finish."` with `{ cause: error }`. Where the host implements [`reportError()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/reportError) — browsers, Web Workers, Deno, and Bun — the original error is additionally passed to it, which dispatches an `error` event, so `window.onerror`, an `addEventListener("error")` handler, and telemetry SDKs observe it exactly as they would an uncaught error, without it being an actual uncaught throw. Node defines no `reportError` global at any supported version, so there the `console.error` is the report.

This containment covers *synchronous* throws from an effect body or its cleanup: such a throw never raises `uncaughtException`, so it cannot by itself terminate a Node server, script, or test process. It does not extend to an `async` effect body, whose rejected promise surfaces as an unhandled rejection — still fatal by default in Node — so `await`ed work needs its own `try`/`catch`. Since a contained failure never reaches the triggering write, code that needs to handle it must do so at the real failure site, inside the effect body or cleanup. Reporting is itself fully guarded: a host that makes `console.error` throw, or exposes `reportError` as a throwing getter, cannot turn a contained effect failure back into an escaping one.

## batch

```ts
batch<T>(fn: () => T): T
```

Groups writes, deferring effect notifications until the callback completes, and returns the callback's result.

## untracked

```ts
untracked<T>(fn: () => T): T
```

Runs the callback without collecting reactive dependencies, and returns its result. Use it to read a signal from inside an effect or computed without subscribing to it.

## deepSignal

```ts
deepSignal<T extends object>(initialValue: T): DeepSignal<T>
```

Adds property-level tracking for plain objects and arrays. Proxies are created lazily and cached, so aliases and cycles retain stable identity.

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

- Only assignment, deletion, and standard array mutations made through `state.value` are observable.
- `state.peek()` returns the untracked raw root and should be used for reads only.
- The root must be a mutable plain object or array containing data properties. Accessor properties, descriptor/prototype changes, and `freeze`/`seal` are rejected in v1, as are non-extensible objects — they are rejected rather than made partially reactive.
- Nested plain objects and arrays are reactive. Class instances, functions, `Date`, `Map`, `Set`, promises, and existing signals are treated as opaque values.

### Opaque Map and Set

Only an opaque `Map` or `Set` reached directly from a reactive plain-object or array proxy is exposed through `state.value` as a read-only view. Its TypeScript type remains the mutable native `Map` or `Set` type for `Signal<T>` compatibility, but mutation methods throw at runtime: `set`, `add`, `delete`, and `clear` are not allowed. Create a new `Map` or `Set`, change that copy, and assign it back instead.

### Where the view guarantee stops

This view guarantee does not cross an opaque boundary. Class instances, `Date`, functions, collection entries, accessor results, prototype state, private fields, closure state, `WeakMap` entries, and Promise internals are raw, non-reactive regions; values obtained through those regions, and opaque values mutated after they are stored, are not protected from direct mutation. To avoid invoking user code, write validation inspects only own data descriptors and `Map` / `Set` entries; it never calls getters or setters and cannot inspect the other internal regions above. Such writes are rejected when those inspected values contain library proxies.

## isSignal

```ts
isSignal(value: unknown): value is ReadonlySignal<unknown>
```

Reports whether a value came from `signal`, `computed`, or `deepSignal`. The custom JSX runtime and the control-flow components route on it, so a false negative degrades a reactive binding into a plain prop instead of raising an error.

### Cross-instance identification

Identification therefore has to work across package instances. Every signal carries a non-enumerable brand under `Symbol.for("react-fine-grained-signals.signal")` whose value is the protocol version, currently `1`, and `isSignal` accepts any value carrying a supported version that also exposes `peek()`. A duplicate copy of the package — pnpm hoisting differences, a monorepo consumer, an ESM/CJS split — or a signal that crossed a realm boundary is still recognized. The brand stays out of `Object.keys`, `JSON.stringify`, object spread, and React's prop diffing.

This fixes identification only. Reactivity additionally requires a shared `alien-signals` instance, because dependency tracking lives in that module's global state; see [the packaging note](design/packaging.md) for why it is a peer dependency. A recognized foreign signal reads correctly, but it propagates updates only while the reactive core underneath is shared.

Assigning the brand into `deepSignal` state throws, because a branded subtree would read as a signal and stop being made reactive.

See also: [React hooks](hooks.md), [rendering optimization](rendering-optimization.md).
