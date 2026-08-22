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

`useSignal` and `useDeepSignal` keep one signal for the component lifetime. For expensive deep initial values, pass a pure factory: `useDeepSignal(() => ({ items: [] }))`. Deep properties read after `useSignals()` are tracked individually, so changing an unread sibling does not rerender the component. `useSignalValue` remains available as a low-level explicit leaf subscription. Use `useDeepSignalValue(state, value => value.user.name, [])` when an explicit primitive selector is preferable; its dependency array is required, must keep a constant length and order, and must list every non-signal value captured by the selector. Mutable object or Proxy selector results are intentionally rejected. `useSignalEffect` starts its effect after commit and disposes it during unmount (including Strict Mode replay). Without a dependency array, its callback must read only signals and its initial closure is retained for the component lifetime. When it captures props, state, or another non-signal value, list those values in the optional dependency array: `useSignalEffect(() => { /* read signals and props */ }, [prop])`.

`useComputed` has two modes:

- Without a dependency array, the getter must read only signals. Its initial closure is retained for the component lifetime, so it must not capture props, React state, or other non-signal values.
- When the getter captures non-signal values, list every such value in the dependency array: `useComputed(() => count.value * step, [step])`. Choose one mode for a component's lifetime.

## Rendering optimization

There are two separate optimization layers. They can be used independently:

1. The runtime hooks and JSX runtime work without a build plugin.
2. The optional `unplugin-react-alien-signals` package inserts `useSignals()` around selected components and custom hooks, with an optional exact managed boundary.

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

The bare runtime boundary is best-effort: tracking closes at the next `useSignals()` call or after the current microtask. It is intended for synchronous component renders. Every component that reads a signal during render must call `useSignals()` itself; reads from effects, event handlers, asynchronous callbacks, or an untracked component can otherwise be attributed to the currently open boundary. Exact separation across Suspense-aborted renders, nested server rendering during a render, and multiple concurrent roots requires the managed transform below.

The JSX runtime provides a second, independent optimization. A signal used as a native host child or an allowlisted host prop is updated as a local DOM leaf, without rerendering the parent component:

```tsx
const title = signal("Initial title");

function Field() {
  return <button title={title}>{title}</button>;
}
```

This direct binding is limited to native HTML `title`, `id`, `className`, `hidden`, `disabled`, `data-*`, and `aria-*` props, plus native host children. It does not unwrap signals passed to React components. See [JSX signal children and host bindings](#jsx-signal-children-and-host-bindings) for the complete list and caveats.

### With a plugin: automatic `useSignals()` insertion

The optional universal build plugin keeps Babel private: configure the integration for your bundler instead of adding a Babel config. By default it detects selected functions and only inserts a normal `useSignals()` call as their first hook. That gives the same best-effort boundary as writing the hook yourself, without a control-flow rewrite. The JSX runtime's native leaf bindings work independently of the plugin.

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

The same package provides `/rollup`, `/webpack`, `/rspack`, and `/esbuild` entry points. It is ESM-only, so use `import` in the bundler configuration. It is currently a private workspace package and is not published to npm; the install and configuration snippets document the intended release API.

`mode` chooses how components opt in:

- `"manual"`: transform an explicit first-statement imported `useSignals()` call, or a named component/custom hook marked with `@useSignals`. This preserves the explicit live-library style.
- `"auto"` (default): additionally transform named JSX components that read `.value`, and named `useX` custom hooks that read `.value`.
- `"all"`: additionally transform every named JSX component. Use it when a component should opt in even though the static `.value` check cannot see a direct read; arbitrary nested callbacks are not transform targets.

`transform` chooses how an opted-in function is generated:

- `"inject"` (default): import normal `useSignals` from `react-alien-signals` and insert its call as the first hook. It does not emit `try` / `finally` or rewrite existing control flow.
- `"managed"`: import from `react-alien-signals/runtime` and emit the advanced `try` / `finally` scope. Choose this only when exact separation across Suspense-aborted renders, nested server rendering during render, or concurrent roots matters.

```ts
// Opt into the exact managed boundary only where that trade-off is wanted.
signals({ mode: "auto", transform: "managed" });
```

`@useSignals` and `@noUseSignals` apply only to their owning function, not nested functions. Automatic modes support top-level declaration and arrow components, including named components wrapped with `memo` or `forwardRef`; arbitrary nested callbacks, class components, anonymous default exports, async/generator functions, and components with an existing `useSignals()` call are not changed. Reapplying either transform mode is a no-op. The `.value` check is intentionally heuristic, so `mode: "auto"` may add a harmless subscription to an object that is not a signal.

Choose the approach based on how much build-time automation you want:

| Goal | Recommended approach |
| --- | --- |
| No plugin or bundler integration | Call `useSignals()` explicitly; use the JSX runtime for native signal children and allowlisted props. |
| Automatic insertion with the normal `useSignals()` behavior | Use the plugin with `mode: "auto"` (the default). |
| Explicit opt-in with an exact render boundary | Use `mode: "manual"` and `transform: "managed"`. |
| Broad migration or components whose reads are hidden from the heuristic | Use `mode: "all"`, then opt out individual functions with `@noUseSignals` where needed. |

The plugin is not required for the core primitives, hooks, or JSX signal bindings. It is a development/build-time convenience for inserting `useSignals()` or, when selected, the managed render boundary; it does not replace `useSignals()` semantics or expand the native host-prop allowlist.

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

## JSX control-flow utilities

`react-alien-signals/utils` provides small React components inspired by Solid's
`Show`, `Switch`/`Match`, and `For`. They are optional and do not need the
build plugin or the custom JSX runtime. When a signal is passed to their
condition or list input, the utility itself forms the reactive boundary, so an
update does not rerender its parent component.

```tsx
import { signal } from "react-alien-signals";
import { For, Index, Match, Show, Switch } from "react-alien-signals/utils";

const signedIn = signal(false);
const showList = signal(true);
const users = signal([{ id: "ada", name: "Ada" }]);
const labels = signal(new Map([["ada", "Ada"]]));

export function Panel() {
  return (
    <>
      <Show when={signedIn} fallback={<p>Please sign in.</p>}>
        {(value) => <p>Signed in: {String(value)}</p>}
      </Show>

      <Switch fallback={<p>Unknown view.</p>}>
        <Match when={showList}><p>User list</p></Match>
        <Match when={false}><p>Never rendered</p></Match>
      </Switch>

      <For each={users} by={(user) => user.id} fallback={<p>No users.</p>}>
        {(user) => <p>{user.name}</p>}
      </For>

      <For each={labels} by={([id]) => id}>
        {([id, label]) => <p>{`${id}: ${label}`}</p>}
      </For>

      <Index each={users}>
        {(user, index) => <p>{`${index}: ${user().name}`}</p>}
      </Index>
    </>
  );
}
```

`Switch` renders the first truthy `Match`; `Match` is meaningful only inside a
`Switch`. `For` is a local React list boundary, not a new renderer. It accepts
arrays, `Set`, and `Map` (whose child receives a `[key, value]` entry), and
always requires `by` for stable React keys. `by` must be pure and derived from
the item rather than generated during render. For an intentionally
position-keyed array, use `Index`: its child receives a render-time accessor
`() => item` and a numeric index.

`deepSignal` supports arrays, so array mutations and deep item reads can be
reactive. `Map` and `Set` are intentionally opaque to `deepSignal`; use
immutable replacement: copy, change, then assign the new collection to the
signal (for example, `const next = new Map(labels.value); next.set("bea",
"Bea"); labels.value = next`). Do not mutate collections while rendering. For
rows that read signals or deep item properties inside a child component, call
`useSignals()` in that row (or use the plugin) so the row owns that
subscription.

## Experimental constraints

- React 19 or newer is required. The JSX runtime uses callback-ref cleanup, which is unavailable in React 18.
- Bare `useSignals()` and the plugin's default `transform: "inject"` use an unmanaged convenience boundary: tracking closes at the next `useSignals()` call or after the current microtask. Call it once, unconditionally, as the component's first hook and only rely on synchronous signal reads made during that render. Reads in effects, event handlers, asynchronous callbacks, or render props whose owning component does not call `useSignals()` are not supported as component dependencies. Exact separation across Suspense-aborted renders, nested `renderToString` / `renderToStaticMarkup` calls made during render, and multiple concurrent roots is best-effort. Use `unplugin-react-alien-signals` with `transform: "managed"` for an exact `try` / `finally` render boundary.
- Direct binding does not support `value`, `checked`, `style`, event handlers, SVG props, or other host props outside the allowlist.
- Direct binding writes outside the React scheduler and remains an experimental optimization.
- Signals passed to React component props or component children are not unwrapped. The direct-binding behavior applies only to native HTML elements (and signal children handled by the JSX runtime).
- Keep whether a host prop is bound fixed for the element lifetime. Switching between a plain value and a signal can change the wrapper type and remount the DOM subtree.
- For SSR and hydration, ensure the initial signal values are identical on server and client. Do not place request-specific signals in shared module scope; create them per request.

## Development

Development requires Node.js 22.18 or newer, pnpm 11, and React 19 or newer. The higher Node.js baseline comes from the `tsdown` build tool; it does not change the runtime requirements of the bundled library.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

To verify the packed ESM packages from a clean Vite consumer (without workspace
aliases), run:

```sh
pnpm test:consumer
```

The browser proof of concept renders the app on the server, hydrates it with React 19, and exercises direct signal bindings in Chromium:

```sh
pnpm exec playwright install --only-shell chromium
pnpm test:browser
```

Run `pnpm dev:browser` to build the transform package and inspect the same example at `http://127.0.0.1:4173`.

## Benchmarks

Benchmarks are manual diagnostics and are not CI performance gates. They measure built output, run correctness checks outside the timed region, and report the median and interquartile timings after warmup.

```sh
pnpm bench
pnpm bench:deep
pnpm bench:transform
```

Core results compare raw `alien-signals`, this package, and `@preact/signals-core`. Compare numbers only on the same machine and Node.js version; hosted CI timing is too variable for a reliable regression threshold.

`bench:transform` builds first, then measures the distributed Vite adapter's
parse, scope, rewrite, source-map, and code-generation path for small and
large TSX modules. It includes a pass-through lower bound and a no-candidate
Babel case, so it can be used later to compare a compatible SWC or Oxc
implementation against the same corpus.
