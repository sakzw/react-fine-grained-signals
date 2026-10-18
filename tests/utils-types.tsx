import { signal } from "../src/index.js";
import { For, Index, Match, Switch } from "react-fine-grained-signals/utils";

const users = signal([{ id: "ada", name: "Ada" }]);
const tags = signal(new Set(["react"]));
const usersById = signal(new Map([["ada", { name: "Ada" }]]));

const keyedArray = (
  <For each={users} by={(user) => user.id}>
    {(user, index) => <p>{`${index}:${user.name}`}</p>}
  </For>
);

const keyedSet = (
  <For each={tags} by={(tag) => tag}>
    {(tag) => <p>{tag}</p>}
  </For>
);

const keyedMap = (
  <For each={usersById} by={([id]) => id}>
    {([id, user]) => <p>{`${id}:${user.name}`}</p>}
  </For>
);

const indexed = (
  <Index each={users}>
    {(user, index) => <p>{`${index}:${user().name}`}</p>}
  </Index>
);

const mode = signal<"list" | "details" | undefined>("list");
const matched = (
  <Switch>
    <Match when={mode} equals="list">
      {(value) => {
        const exact: "list" = value;
        return <p>{exact}</p>;
      }}
    </Match>
    <Match when={mode} equals={undefined}>
      {(value) => {
        const exact: undefined = value;
        return <p>{String(exact)}</p>;
      }}
    </Match>
    <Match when={mode}>
      {(value) => {
        const nonNull: "list" | "details" = value;
        return <p>{nonNull}</p>;
      }}
    </Match>
  </Switch>
);

const falsy = signal<false | 0 | "" | null | undefined>(false);
const falsyMatch = <Match when={falsy} equals={false}>{(value) => {
  const exact: false = value;
  return <p>{String(exact)}</p>;
}}</Match>;

// @ts-expect-error equals must be assignable to the value type of when.
const invalidEquals = <Match when={mode} equals={42}><p>invalid</p></Match>;

// @ts-expect-error For requires an identity key; use Index for positional lists.
const missingKey = <For each={users}>{(user) => <p>{user.name}</p>}</For>;

void [keyedArray, keyedSet, keyedMap, indexed, missingKey, matched, falsyMatch, invalidEquals];
