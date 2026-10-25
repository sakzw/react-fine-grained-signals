# Core primitives

[English](./core-primitives.md) | [日本語](./core-primitives.ja.md)

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
signal<T>(initialValue: T): FormBindableSignal<T>
```

Creates a writable reactive value.

- `.value` reads and writes it; reading inside a tracked scope registers a dependency.
- `.peek()` reads the current value without registering one.
- Writes use `Object.is` equality, so assigning an equal value notifies nothing.

## computed

```ts
computed<T>(getter: () => T): ReadonlySignal<T>
computed<T>(options: { get: () => T; set: (value: T) => void }): FormBindableSignal<T>
```

Creates a lazily evaluated, read-only derived value. It exposes the same `.value` and `.peek()` as `signal`, and re-evaluates on the next read after a dependency its getter read has changed.

Pass a getter and setter object to create a writable computed value. The getter remains the source of truth; assigning `.value` calls the user setter and does not copy a value into a second signal. The setter runs untracked and inside a batch, so reading other signals in the setter does not add dependencies and multiple writes notify observers after the setter finishes.

```ts
const first = signal("John");
const last = signal("Smith");
const fullName = computed({
  get: () => `${first.value} ${last.value}`,
  set: (value) => {
    const [nextFirst = "", ...rest] = value.split(" ");
    first.value = nextFirst;
    last.value = rest.join(" ");
  },
});

fullName.value = "Ada Lovelace";
console.log(fullName.value); // "Ada Lovelace"
```

The getter-only form remains `ReadonlySignal<T>` and cannot be used with writable JSX form bindings. The getter/setter form returns `FormBindableSignal<T>`, a writable package `Signal<T>` that works with `bindValue`, `bindChecked`, and single or multiple select bindings when its value type matches. A setter need not be a mathematical inverse: after assignment, reads show whatever the getter derives from the state the setter wrote. Keep the `FormBindableSignal<T>` type when passing it through reusable form props; widening it to `Signal<T>` loses the binding capability and is rejected by JSX types.

`FormBindableSignal<T>` carries a type-only capability so TypeScript can distinguish package-created writable sources from arbitrary structural signals and getter-only computed values. That marker is not a JavaScript property. At runtime, the binding checks the package's private signal brand and writability.

### When the getter throws

The write that triggered re-evaluation still completes normally. The error is cached and rethrown from `.value` and `.peek()` on the next read of that computed instead, so a `useSignalValue`/`useSignalTracking()` read of it during React's render reaches an Error Boundary.

A later write to a dependency the getter did read before failing correctly triggers re-evaluation on the next read, so the computed recovers once its inputs make the getter succeed again. A dependency the getter never reached because it threw first is not tracked, so a write to only that dependency does not by itself trigger re-evaluation.

## effect

```ts
effect(fn: () => void | (() => void)): () => void
```

Runs `fn` immediately, then again whenever a signal it read changes. Returns a disposer.

- A function returned from `fn` is its cleanup, run before the next execution and when the effect is disposed.
- A thrown error is contained rather than propagated to the write that triggered the run.
- An effect created while another effect (or a computed) runs is owned by it, as in v0.1: the owner's next run and its disposal dispose the nested effect, running its cleanup before the owner's own. Disposing a nested effect yourself is also fine.
- An effect that calls its own disposer stops depending on everything, including signals it reads later in that same run.

### Error containment

If an `effect()` callback throws — either its body or the cleanup function it returned — the error does not propagate to the write that triggered the run. The runtime contains and reports that failure so it cannot cancel unrelated effects already queued in the same flush. The failing effect keeps reacting to later writes, and a cleanup failure does not prevent its body from re-running.

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

Runs the callback without collecting reactive dependencies, and returns its result. Use it to read a signal from inside an effect or computed without subscribing to it. It also suppresses tracking by another installed copy of this package, so a library that bundles its own copy can read your signals untracked.

## deepSignal

```ts
deepSignal<T extends object>(initialValue: T): DeepSignal<T>
```

Adds property-level tracking for plain objects, arrays, and same-realm standard collections. Proxies are created lazily and cached, so aliases and cycles retain stable identity.

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
- The root must be a mutable plain object, array, or same-realm standard collection. Accessor properties, descriptor/prototype changes, and `freeze`/`seal` are rejected in v1, as are non-extensible objects — they are rejected rather than made partially reactive.
- Nested plain objects, arrays, `Map`, `Set`, `WeakMap`, and `WeakSet` values are reactive. Class instances, functions, `Date`, promises, and existing signals are treated as opaque values.
- Array mutation methods (`push`, `splice`, `sort`, ...) do not subscribe the caller to the array they change; only the readers of the affected indices, `length`, and keys are notified. A `push` inside an effect therefore does not make that effect re-run on every later push.
- Key enumeration and own-key checks (`Object.keys`, `for...in`, `Object.hasOwn`, `hasOwnProperty.call`) depend on which keys exist, not on their values. Reading a value through `Object.getOwnPropertyDescriptor(...).value` is not tracked as a value read; read the property itself.
- Keys inherited from `Object.prototype` (`constructor`, `toString`, ...) stay reactive in dictionary-style objects: reading or checking one re-runs once it becomes an own property.

### Reactive collections

Collections are reactive by default, including collection roots:

```ts
const state = deepSignal(new Map<string, { count: number }>());
state.value.set("item", { count: 1 });
```

Map `get` and `has` track independently per key; `size`, key iteration, and entry iteration have separate dependencies. Set `has`, `size`, and iteration are tracked separately. Weak collections track only their key operations and cannot be enumerated or observed through `size` or `clear`.

Collection keys, members, and values that are plain objects or arrays are stored raw and returned as deep proxies. Raw keys and proxies created by this runtime identify the same entry. Mutating the original collection or a collection returned by `.peek()` bypasses notifications. Weak collection entries cannot be scanned during initialization; method calls through the reactive proxy normalize keys and wrap returned values lazily. Symbol keys follow the native runtime's WeakMap/WeakSet key rules. Only same-realm built-in collections are supported.

A Map key or Set member that is a plain object containing a deep proxy (a "carrier") is stored as a normalized copy, and its entry identity is fixed by the caller's object at first insertion: mutating the carrier afterwards keeps addressing the same entry (`set`, `add`, `get`, `has`, and `delete` do not create a second one), and the stored copy does not see the later mutation. If the entry is deleted, re-adding the carrier stores a fresh copy. Writing an already-present key or an unchanged value does not revalidate it, so `Map.set(existingKey, value)` does not cost a walk of the key graph.

`Set.prototype.union`, `intersection`, `difference`, and `symmetricDifference` called through the reactive proxy return a plain (non-reactive) `Set` whose members read like every other path: members of the receiver are deep proxies, and members that only came from the argument keep the identity the argument held (a reactive collection's members are proxies; objects in a plain `Set` stay as they are). Mutating a returned proxy member updates the state; adding to or removing from the returned `Set` does not. The argument is consumed in the order the native `GetSetRecord` algorithm uses (`size`, then `has`, then `keys`, each read once, with native validation errors). Built-in `Set`/`Map` arguments and reactive collections may hold either raw members or proxies; any other set-like object sees one `has` call per member with the raw member.

## isSignal

```ts
isSignal(value: unknown): value is ReadonlySignal<unknown>
```

Reports whether a value came from `signal`, `computed`, or `deepSignal`. The custom JSX runtime and the control-flow components route on it, so a false negative degrades a reactive binding into a plain prop instead of raising an error.

### Only one copy of the package

Install a single copy of `react-fine-grained-signals`. Every signal carries a non-enumerable brand under `Symbol.for("react-fine-grained-signals.signal.v2")`, and each copy keeps its own graph, so a signal can only be read by the copy that created it. If a second copy is loaded (pnpm hoisting differences, a monorepo consumer, an ESM/CJS split), mixing them is an error rather than a silently stale value: a read that crosses copies from inside an `effect`, a `computed`, or a tracked component throws `Multiple copies of react-fine-grained-signals are loaded`, and `isSignal` throws for a signal the other copy created. The brand stays out of `Object.keys`, `JSON.stringify`, object spread, and React's prop diffing.

Fix the duplication in the install: run your package manager's dedupe (pnpm's `dedupe-peer-dependents`, `npm dedupe`), or make the bundler resolve one copy (Vite and Rollup's `resolve.dedupe: ["react-fine-grained-signals"]`, webpack's `resolve.alias`).

Detection has a limit. A plain read of another copy's signal made outside any `effect`, `computed`, or tracked component has nothing on the stack to mark it, so it returns that signal's current value without an error. It will not update anything, which is the same as reading any value outside reactive code.

The brand key names the v0.2 generation. v0.1.x used `react-fine-grained-signals.signal` and does not recognize v0.2 signals (nor the reverse), so keep a single major line of this package per page.

Assigning the brand into `deepSignal` state throws, because a branded subtree would read as a signal and stop being made reactive.

Assigning the brand into `deepSignal` state throws, because a branded subtree would read as a signal and stop being made reactive.

See also: [React hooks](./hooks.md), [rendering optimization](./rendering-optimization.md).
