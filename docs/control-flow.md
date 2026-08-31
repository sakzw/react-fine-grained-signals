# JSX control-flow utilities

[English](control-flow.md) | [日本語](control-flow.ja.md)

```tsx
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";
```

`react-fine-grained-signals/utils` provides small React components inspired by Solid's `Show`, `Switch`/`Match`, and `For`. They are optional and need neither the build plugin nor the custom JSX runtime.

Every input marked `SignalInput<T>` below is `T | ReadonlySignal<T>`: pass a plain value or a signal. When a signal is passed, the utility itself forms the reactive boundary, so an update rerenders the utility and not its parent component.

## Show

```ts
interface ShowProps<T> {
  when: SignalInput<T>;
  fallback?: ReactNode;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
```

Renders its children only while `when` is truthy.

```tsx
<Show when={signedIn} fallback={<p>Please sign in.</p>}>
  {(value) => <p>Signed in: {String(value)}</p>}
</Show>
```

- A function child receives the narrowed truthy value; a plain node child is rendered as is.
- `fallback` defaults to `null`.

## Switch and Match

```ts
interface SwitchProps {
  fallback?: ReactNode;
  children?: ReactNode;
}

interface MatchProps<T> {
  when: SignalInput<T>;
  children: ReactNode | ((value: NonNullable<T>) => ReactNode);
}
```

`Switch` renders the first `Match` whose `when` is truthy.

```tsx
<Switch fallback={<p>Unknown view.</p>}>
  <Match when={showList}><p>User list</p></Match>
  <Match when={false}><p>Never rendered</p></Match>
</Switch>
```

- `Match` is meaningful only as a child of `Switch`; on its own it renders nothing.
- Later branches are not evaluated once one matches.

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
- For a row that reads signals or deep item properties inside a child component, call `useSignals()` in that row (or use the plugin) so the row owns the subscription.

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

`deepSignal` supports arrays, so array mutations and deep item reads can be reactive. `Map` and `Set` are intentionally opaque to it.

A `Map` or `Set` reached directly from a reactive plain object or array is exposed by `.value` as a read-only runtime view, although its TypeScript type remains mutable. Use immutable replacement: copy, change, then assign the new collection to the signal.

```ts
const next = new Map(labels.value);
next.set("bea", "Bea");
labels.value = next;
```

Do not mutate collections while rendering.

See also: [core primitives](core-primitives.md), [React hooks](hooks.md).
