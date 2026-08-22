# react-alien-signals

[English](README.md) | [日本語](README.ja.md)

An experimental React binding for [alien-signals](https://www.npmjs.com/package/alien-signals). It provides small reactive primitives, React hooks, and an opt-in JSX runtime for a deliberately narrow set of direct DOM bindings.

## Core primitives

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

### Deep signals

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

## React hooks

```tsx
import { useComputed, useDeepSignal, useDeepSignalValue, useSignal, useSignalEffect, useSignalValue } from "react-alien-signals";

function Counter({ step }: { step: number }) {
  const count = useSignal(0);
  const scaled = useComputed(() => count.value * step, [step]);
  const value = useSignalValue(scaled);

  useSignalEffect(() => {
    console.log("count:", count.value);
  });

  return <button onClick={() => (count.value += step)}>{value}</button>;
}
```

`useSignal` and `useDeepSignal` keep one signal for the component lifetime. For expensive deep initial values, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`. The hook creates state only; reading `state.value` during render does not implicitly subscribe React. Use `useDeepSignalValue(state, value => value.user.name, [])` for a property-level React subscription. Its dependency array is required, must keep a constant length and order, and must list every non-signal value captured by the selector. Selectors return primitive snapshots only; mutable object or Proxy snapshots are intentionally rejected. `useSignalEffect` starts its effect after commit and disposes it during unmount (including Strict Mode replay).

`useComputed` has two modes:

- Without a dependency array, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- When the getter captures non-signal values, list every such value in the dependency array: `useComputed(() => count.value * step, [step])`. Choose one mode for a component's lifetime.

## JSX signal children and host bindings

Configure TypeScript to use the supplied automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-alien-signals"
  }
}
```

A signal used as a native host child, including SVG text content, becomes a local reactive leaf, so it can update without rerendering its parent. The same runtime supports direct bindings only for these native HTML props:

- `title`, `id`, `className`, `hidden`, and `disabled`
- `data-*` and `aria-*` attributes

```tsx
const title = signal("Initial title");
const disabled = signal(false);

export function Field() {
  return <button title={title} disabled={disabled}>{title}</button>;
}
```

## Experimental constraints

- React 19 or newer is required. The JSX runtime uses callback-ref cleanup, which is unavailable in React 18.
- `useSignals()` with no arguments is not implemented because React's public APIs provide no safe render-end boundary for closing automatic dependency tracking without a transform or React internals. Use `useSignalValue` or `useDeepSignalValue` for explicit subscriptions.
- Direct binding does not support `value`, `checked`, `style`, event handlers, SVG props, or other host props outside the allowlist.
- Direct binding writes outside the React scheduler and remains an experimental optimization.
- Signals passed to React component props or component children are not unwrapped. The direct-binding behavior applies only to native HTML elements (and signal children handled by the JSX runtime).
- Keep whether a host prop is bound fixed for the element lifetime. Switching between a plain value and a signal can change the wrapper type and remount the DOM subtree.
- For SSR and hydration, ensure the initial signal values are identical on server and client. Do not place request-specific signals in shared module scope; create them per request.

## Development

Requires Node.js 22.12 or newer, pnpm 11, and React 19 or newer.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The browser proof of concept renders the app on the server, hydrates it with React 19, and exercises direct signal bindings in Chromium:

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:browser
```

Run `pnpm dev:browser` to inspect the same example at `http://127.0.0.1:4173`.

## Benchmarks

Benchmarks are manual diagnostics and are not CI performance gates. They measure built output, run correctness checks outside the timed region, and report the median and interquartile timings after warmup.

```sh
pnpm bench
pnpm bench:deep
```

Core results compare raw `alien-signals`, this package, and `@preact/signals-core`. Compare numbers only on the same machine and Node.js version; hosted CI timing is too variable for a reliable regression threshold.
