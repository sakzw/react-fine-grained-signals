# JSX control-flow utilities

[English](./control-flow.md) | [日本語](./control-flow.ja.md)

```tsx
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";
```

`react-fine-grained-signals/utils` provides small React components inspired by Solid's `Show`, `Switch`/`Match`, and `For`. They are optional and need neither the build plugin nor the custom JSX runtime.

Every input marked `SignalInput<T>` below is a plain `T`, a `ReadonlySignal<T>`, or a `deepSignal` / `deepCollectionSignal` whose `.value` is a `T`. When a signal is passed, the utility itself forms the reactive boundary, so an update rerenders the utility and not its parent component.

A deep signal can be passed directly, including to `each`, which also accepts a deep signal over a mutable array, `Set` or `Map` (`deepSignal([...])`, `deepCollectionSignal(new Set())`). The utility reads it inside its own scope, so in-place mutations such as `todos.value.push(todo)` or `tags.value.add(tag)` rerender it without replacing the root, as do the nested properties its render callback reads. The item type is the plain state type from `.value`, not the read-only type of `peek()`, so a row's event handler can write to its item (`item.done = true`). A nested array read through `.value` (`each={state.value.todos}`) works the same way.

## Show

```ts
interface ShowProps<T> {
  when: SignalInput<T>;
  fallback?: ReactNode;
  children: ReactNode | ((value: Truthy<T>) => ReactNode);
}
```

Renders its children only while `when` is truthy.

```tsx
<Show when={signedIn} fallback={<p>Please sign in.</p>}>
  {(value) => <p>Signed in: {String(value)}</p>}
</Show>
```

- A function child receives the truthy value, typed `Truthy<T>`: `null`, `undefined`, `false`, `0`, `""` and `0n` are removed from `T`, so a `0 | 1 | null` signal gives `1`. Wider types such as `number` or `string` are unchanged. A plain node child is rendered as is.
- `fallback` defaults to `null`.

## Switch and Match

```ts
interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}
```

`Match` has two forms, typed by its overloads: `when` with `equals` (the child receives the value narrowed to the matched literal), or `when` alone (the child receives a `Truthy<T>`; `equals` is not allowed).

`Switch` renders the first `Match` that matches. Without `equals`, `when` uses its
legacy truthy test. With `equals`, `Switch` compares the `when` value using
`Object.is`; this is value equality, not a predicate callback. Equal matching
supports falsy values, including `0`, `false`, `""`, `null`, and `undefined`.

```tsx
<Switch fallback={<p>Unknown view.</p>}>
  <Match when={showList}><p>User list</p></Match>
  <Match when={view} equals="list">{(value) => <p>{value} view</p>}</Match>
  <Match when={view} equals="details"><p>Details</p></Match>
  <Match when={count} equals={0}><p>No items</p></Match>
</Switch>
```

- `Match` is meaningful only as a child of `Switch`; on its own it renders nothing.
- Later branches are not evaluated once one matches.
- Pass a signal itself (`when={view}`) to let `Switch` read and subscribe to it.
  An expression such as `when={view.value === "list"}` is evaluated by the
  parent while it creates the JSX, so the parent owns that read and may rerender.
- `equals={undefined}` is an explicit `Object.is(value, undefined)` comparison;
  omitting `equals` keeps the legacy truthy behavior. Function children in an
  equals branch receive the matched value narrowed to the `equals` type.

## For

```ts
interface ForProps<T> {
  each: SignalInput<readonly T[] | ReadonlySet<T> | null | undefined>;
  fallback?: ReactNode;
  by: (item: T, index: number) => Key;
  children: (item: T, index: number) => ReactNode;
}

interface ForMapProps<K, V> {
  each: SignalInput<ReadonlyMap<K, V> | null | undefined>;
  fallback?: ReactNode;
  by: (entry: readonly [K, V], index: number) => Key;
  children: (entry: readonly [K, V], index: number) => ReactNode;
}
```

Renders a list whose items have stable identities. It is a local React list boundary, not a new renderer: React still owns reconciliation.

```tsx
<For each={users} by={(user) => user.id} fallback={<p>No users.</p>}>
  {(user) => <p>{user.name}</p>}
</For>

<For each={labels} by={([id]) => id}>
  {([id, label]) => <p>{`${id}: ${label}`}</p>}
</For>
```

- Accepts arrays, `Set`, and `Map`. For a `Map`, both `by` and the child receive a `[key, value]` entry.
- `by` is always required, and must be pure and derived from the item rather than generated during render.
- When the collection changes, `For` invokes `by` and `children` for every item. React keys preserve row identity and state, but do not skip the callback or React reconciliation work for unchanged items.
- For a row that reads signals or deep item properties inside a child component, call `useSignalTracking()` in that row (or use the plugin) so the row owns the subscription.

## Index

```ts
interface IndexProps<T> {
  each: SignalInput<readonly T[] | null | undefined>;
  fallback?: ReactNode;
  children: (item: () => T, index: number) => ReactNode;
}
```

Renders an array whose row identity is intentionally its position, so it takes no `by`.

```tsx
<Index each={users}>
  {(user, index) => <p>{`${index}: ${user().name}`}</p>}
</Index>
```

- The child receives a render-time accessor `() => item`, not the item itself. Read it during render.
- Use `For` instead whenever items have their own identity.

## Map and Set inputs

`deepCollectionSignal` tracks same-realm `Map`, `Set`, `WeakMap`, and `WeakSet` values, including nested collections (`deepSignal` treats them as opaque values). Read and mutate them through `.value`; raw collection references and `.peek()` bypass notifications.

Mutations through a collection obtained from `.value` are reactive and notify the consumers that read the affected key or iteration dependency. You can update the collection in place; immutable replacement remains an option when it makes the surrounding state update clearer.

```ts
const next = new Map(labels.value);
next.set("bea", "Bea");
labels.value = next;
```

Do not mutate collections while rendering.

See also: [core primitives](./core-primitives.md), [React hooks](./hooks.md).
