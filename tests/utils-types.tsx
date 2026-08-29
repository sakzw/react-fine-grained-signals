import { signal } from "../src/index.js";
import { For, Index } from "react-fine-grained-signals/utils";

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

// @ts-expect-error For requires an identity key; use Index for positional lists.
const missingKey = <For each={users}>{(user) => <p>{user.name}</p>}</For>;

void [keyedArray, keyedSet, keyedMap, indexed, missingKey];
