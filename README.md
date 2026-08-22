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

`useSignal` and `useDeepSignal` keep one signal for the component lifetime. For expensive deep initial values, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`. Deep properties read after `useSignals()` are tracked individually, so changing an unread sibling does not rerender the component. `useSignalValue` remains available as a low-level explicit leaf subscription. Use `useDeepSignalValue(state, value => value.user.name, [])` when an explicit primitive selector is preferable; its dependency array is required, must keep a constant length and order, and must list every non-signal value captured by the selector. Mutable object or Proxy selector results are intentionally rejected. `useSignalEffect` starts its effect after commit and disposes it during unmount (including Strict Mode replay).

`useComputed` has two modes:

- Without a dependency array, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- When the getter captures non-signal values, list every such value in the dependency array: `useComputed(() => count.value * step, [step])`. Choose one mode for a component's lifetime.

## Rendering optimization

There are two separate optimization layers. They can be used independently:

1. The runtime hooks and JSX runtime work without a build plugin.
2. The optional `unplugin-react-alien-signals` package automates the render boundary around components and custom hooks.

Neither layer makes every React component signal-driven. React still owns the component tree and scheduling; the optimization narrows the work caused by signal changes to the component or native DOM leaf that actually read the signal.

### Without a plugin: explicit live tracking

Use `useSignals()` when you want the live-library style without changing the build. It must be the first hook and must be called unconditionally:

```tsx
function Counter() {
  useSignals();
  const count = useSignal(0);

  return <button onClick={() => count.value++}>{count.value}</button>;
}
```

Synchronous signal reads made during the render after `useSignals()` are collected, and a change to one of those values schedules a rerender of that component. With `deepSignal`, property reads are tracked individually, so an unread sibling does not cause a rerender. This is the simplest option when you want explicit control and no build configuration.

The bare runtime boundary is best-effort: tracking closes at the next `useSignals()` call or after the current microtask. It is intended for synchronous component renders. Reads from effects, event handlers, asynchronous callbacks, or render props whose owning component does not call `useSignals()` are not component dependencies. Exact separation across Suspense-aborted renders, nested server rendering during a render, and multiple concurrent roots requires the managed transform below.

The JSX runtime provides a second, independent optimization. A signal used as a native host child or an allowlisted host prop is updated as a local DOM leaf, without rerendering the parent component:

```tsx
const title = signal("Initial title");

function Field() {
  return <button title={title}>{title}</button>;
}
```

This direct binding is limited to native HTML `title`, `id`, `className`, `hidden`, `disabled`, `data-*`, and `aria-*` props, plus native host children. It does not unwrap signals passed to React components. See [JSX signal children and host bindings](#jsx-signal-children-and-host-bindings) for the complete list and caveats.

### With a plugin: managed render tracking

The optional universal build plugin creates a synchronous managed render scope around selected functions. It keeps Babel private: configure the integration for your bundler instead of adding a Babel config. Generated code closes tracking with `try` / `finally` on returns, errors, and Suspense throws. In other words, the plugin improves the accuracy of the `useSignals()` boundary; the JSX runtime's native leaf bindings work independently of it.

```sh
# Planned package name — it is not published to npm yet.
pnpm add -D unplugin-react-alien-signals
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import signals from "unplugin-react-alien-signals/vite";

export default defineConfig({
  plugins: [signals({ mode: "auto" })],
});
```

The same package provides `/rollup`, `/webpack`, `/rspack`, and `/esbuild` entry points. It is currently a private workspace package and is not published to npm; the install and configuration snippets document the intended release API.

`mode` chooses how components opt in:

- `"manual"`: transform an explicit first-statement imported `useSignals()` call, or a named component/custom hook marked with `@useSignals`. This preserves the explicit live-library style.
- `"auto"` (default): additionally transform named JSX components that read `.value`, and named `useX` custom hooks that read `.value`.
- `"all"`: additionally transform every named JSX component. Use it for render props or getters that hide signal reads from the static check.

`@noUseSignals` always opts a function out. Automatic modes support declaration and arrow components, including named components wrapped with `memo` or `forwardRef`; class components, anonymous default exports, already-transformed JSX, async/generator functions, namespace imports, and components with a late/conditional `useSignals()` call are left unchanged. The `.value` check is intentionally heuristic, so `mode: "auto"` may add a harmless subscription to an object that is not a signal.

Choose the approach based on how much build-time automation you want:

| Goal | Recommended approach |
| --- | --- |
| No plugin or bundler integration | Call `useSignals()` explicitly; use the JSX runtime for native signal children and allowlisted props. |
| Explicit opt-in with an exact render boundary | Use the plugin with `mode: "manual"` and an explicit `useSignals()` call or `@useSignals`. |
| Automatic detection for ordinary named components and custom hooks | Use the plugin with `mode: "auto"` (the default). |
| Broad migration or components whose reads are hidden from the heuristic | Use `mode: "all"`, then opt out individual functions with `@noUseSignals` where needed. |

The plugin is not required for the core primitives, hooks, or JSX signal bindings. It is a development/build-time convenience for inserting the managed render boundary, and it does not replace `useSignals()` semantics or expand the native host-prop allowlist.

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
- Without the managed transform, bare `useSignals()` is an unmanaged convenience API: tracking closes at the next `useSignals()` call or after the current microtask. Call it once, unconditionally, as the component's first hook and only rely on synchronous signal reads made during that render. Reads in effects, event handlers, asynchronous callbacks, or render props whose owning component does not call `useSignals()` are not supported as component dependencies. Exact separation across Suspense-aborted renders, nested `renderToString` / `renderToStaticMarkup` calls made during render, and multiple concurrent roots is best-effort in bare mode. Use `unplugin-react-alien-signals` for an exact `try` / `finally` render boundary.
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
