import { signal } from "react-alien-signals";
import { useSignals as useManagedSignals } from "react-alien-signals/runtime";
import { For, Index, Match, Show, Switch } from "react-alien-signals/utils";

const count = signal(0);
const users = signal([{ id: "ada", name: "Ada" }]);
const labels = signal(new Map([["ada", "Ada"]]));

export function Counter() {
  return <output>{count.value}</output>;
}

/** @noUseSignals */
export function ManagedBoundary() {
  const signals = useManagedSignals();
  try {
    return <output>{count.value}</output>;
  } finally {
    signals.f();
  }
}

export function Utilities() {
  return (
    <>
      <Show when={count} fallback={<p>zero</p>}>
        {(value) => <p>{value}</p>}
      </Show>
      <Switch fallback={<p>fallback</p>}>
        <Match when={count}><p>counted</p></Match>
      </Switch>
      <For each={users} by={(user) => user.id}>
        {(user) => <p>{user.name}</p>}
      </For>
      <For each={labels} by={([id]) => id}>
        {([id, label]) => <p>{`${id}:${label}`}</p>}
      </For>
      <Index each={users}>
        {(user, index) => <p>{`${index}:${user().name}`}</p>}
      </Index>
    </>
  );
}
