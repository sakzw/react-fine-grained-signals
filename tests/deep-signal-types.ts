import { deepSignal } from "../src/index.js";
import type { DeepSignal, Signal } from "../src/index.js";

type State = {
  user: {
    name: string;
    optional?: { label: string };
  };
  items: Array<{ done: boolean }>;
  tuple: [string, { count: number }];
};

const state = deepSignal<State>({
  user: { name: "Ada" },
  items: [{ done: false }],
  tuple: ["first", { count: 0 }],
});

const signalCompatible: Signal<State> = state;
const deepSignalCompatible: DeepSignal<State> = state;
const name: string = state.value.user.name;
const firstTupleValue: string = state.value.tuple[0];

state.value.user.name = "Grace";
state.value.items[0]!.done = true;
state.value.tuple[1].count++;
state.value.user.optional = { label: "present" };
state.value.user.optional.label = "updated";
state.value = {
  user: { name: "Lin" },
  items: [],
  tuple: ["replacement", { count: 1 }],
};

// @ts-expect-error nested values retain their declared type.
state.value.user.name = 1;
// @ts-expect-error array elements retain their declared shape.
state.value.items.push({ done: "yes" });
// @ts-expect-error tuples retain their element types.
state.value.tuple[0] = 1;
// @ts-expect-error optional objects still reject undeclared members.
state.value.user.optional?.missing;
// @ts-expect-error root replacements must match the root state shape.
state.value = { user: { name: "incomplete" } };

void [signalCompatible, deepSignalCompatible, name, firstTupleValue];
