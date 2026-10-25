import { computed, deepSignal, signal } from "react-fine-grained-signals";
import { memo, useEffect, useState } from "react";
import { For, Index, Match, Show, Switch } from "react-fine-grained-signals/utils";

const count = signal(0);
const users = signal([{ id: "ada", name: "Ada" }]);
const labels = signal(new Map([["ada", "Ada"]]));
const tooltip = signal("spread");

// One small consumer-style tree exercises APIs that are usually tested in
// separate unit fixtures. consumer-smoke packs both public packages before
// compiling and rendering this module.
export const canaryState = {
  count: signal(1),
  profile: deepSignal({ user: { name: "Ada" } }),
  labels: deepSignal(new Map([["ada", "Ada"]])),
  features: deepSignal(new Set(["signals"])),
  title: signal("initial title"),
  active: signal(false),
  text: signal("ready"),
  checked: signal(false),
  radio: signal("first"),
  selected: signal("one"),
  visible: signal(true),
  view: signal<"list" | "details">("list"),
};
const canaryDouble = computed(() => canaryState.count.value * 2);
const writableCanaryText = computed({
  get: () => canaryState.text.value,
  set: (next: string) => {
    if (next.length <= 12) canaryState.text.value = next;
  },
});
let unrelatedCommits = 0;
let consumerCommits = 0;

export function readUnrelatedCommitCount() {
  return unrelatedCommits;
}

export function readConsumerCommitCount() {
  return consumerCommits;
}

export function resetConsumerCanary() {
  canaryState.count.value = 1;
  canaryState.profile.value.user.name = "Ada";
  canaryState.labels.value.set("ada", "Ada");
  canaryState.features.value.add("signals");
  canaryState.title.value = "initial title";
  canaryState.active.value = false;
  canaryState.text.value = "ready";
  canaryState.checked.value = false;
  canaryState.radio.value = "first";
  canaryState.selected.value = "one";
  canaryState.visible.value = true;
  canaryState.view.value = "list";
}

function synchronousCountHelper() {
  return canaryState.count.value;
}

const CanaryChild = memo(function CanaryChild() {
  return <output data-testid="shared-child">{canaryState.count}</output>;
});
const UnrelatedConsumer = memo(function UnrelatedConsumer() {
  useEffect(() => {
    unrelatedCommits += 1;
  });
  return <output data-testid="unrelated-renders">stable</output>;
});

function ConditionalCanary() {
  return <output data-testid="conditional">{canaryState.count}</output>;
}

export function ConsumerCanary() {
  const [reactCount, setReactCount] = useState(0);
  const { user } = canaryState.profile.value;
  useEffect(() => {
    consumerCommits += 1;
  });
  return (
    <main>
      <output data-testid="count">{canaryState.count}</output>
      <output data-testid="computed">{canaryDouble}</output>
      <output data-testid="deep-name">{user.name}</output>
      <output data-testid="map-value">{canaryState.labels.value.get("ada")}</output>
      <output data-testid="set-has">{String(canaryState.features.value.has("signals"))}</output>
      <output data-testid="helper">{synchronousCountHelper()}</output>
      <output data-testid="react-state">{reactCount}</output>
      <CanaryChild />
      <UnrelatedConsumer />
      <button data-testid="count-up" title={canaryState.title} data-active={canaryState.active} onClick={() => {
        canaryState.count.value += 1;
        canaryState.profile.value.user.name = "Grace";
        canaryState.labels.value.set("ada", "Grace");
        canaryState.features.value.add("collections");
        canaryState.title.value = "updated title";
        canaryState.active.value = true;
      }}>Update shared state</button>
      <button data-testid="count-only-up" onClick={() => {
        canaryState.count.value += 1;
      }}>Update only count</button>
      <button data-testid="react-count-up" onClick={() => setReactCount((value) => value + 1)}>Update React state</button>
      <button data-testid="replace-and-delete" onClick={() => {
        canaryState.profile.value = { user: { name: "Lin" } };
        canaryState.labels.value.delete("ada");
        canaryState.features.value.delete("signals");
      }}>Replace profile and delete collection entries</button>
      <button data-testid="toggle-conditional" onClick={() => {
        canaryState.visible.value = !canaryState.visible.value;
      }}>Toggle conditional</button>
      <button data-testid="switch-details" onClick={() => {
        canaryState.view.value = "details";
      }}>Show details</button>
      <Switch>
        <Match when={canaryState.view} equals="list"><p data-testid="switch-view">list</p></Match>
        <Match when={canaryState.view} equals="details"><p data-testid="switch-view">details</p></Match>
      </Switch>
      {canaryState.visible.value ? <ConditionalCanary /> : null}
      <input data-testid="text" bindValue={writableCanaryText} />
      <input data-testid="checkbox" type="checkbox" value="admin" bindChecked={canaryState.checked} />
      <input data-testid="radio-first" type="radio" name="canary-radio" value="first" bindValue={canaryState.radio} />
      <input data-testid="radio-second" type="radio" name="canary-radio" value="second" bindValue={canaryState.radio} />
      <select data-testid="select" bindValue={canaryState.selected}>
        <option value="one">One</option><option value="two">Two</option>
      </select>
    </main>
  );
}

export function Counter() {
  return <output>{count.value}</output>;
}

// A key after a spread is the one shape the automatic runtime cannot express,
// so compilers fall back to `createElement` from the package root.
export function SpreadKey(props: { id: string }) {
  return <p {...props} key="spread" title={tooltip} />;
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
