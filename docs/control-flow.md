# JSX control-flow utilities

[English](control-flow.md) | [日本語](control-flow.ja.md)

`react-fine-grained-signals/utils` provides small React components inspired by Solid's
`Show`, `Switch`/`Match`, and `For`. They are optional and do not need the
build plugin or the custom JSX runtime. When a signal is passed to their
condition or list input, the utility itself forms the reactive boundary, so an
update does not rerender its parent component.

```tsx
import { signal } from "react-fine-grained-signals";
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";

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
reactive. `Map` and `Set` are intentionally opaque to `deepSignal`. A `Map`
or `Set` reached directly from a reactive plain object or array is exposed by
`.value` as a read-only runtime view (although its TypeScript type remains
mutable); use immutable replacement: copy, change, then assign the new
collection to the signal. For example:

```ts
const next = new Map(labels.value);
next.set("bea", "Bea");
labels.value = next;
```

Do not mutate collections while rendering. For rows that read signals or deep item
properties inside a child component, call
`useSignals()` in that row (or use the plugin) so the row owns that
subscription.

See also: [core primitives](core-primitives.md), [React hooks](hooks.md).
