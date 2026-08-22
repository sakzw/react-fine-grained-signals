import { useDeepSignal } from "../src/index.js";
import type { DeepSignal } from "../src/index.js";

type State = {
  profile: {
    name: string;
    optional?: { label: string };
  };
  tasks: Array<{ id: number; done: boolean }>;
  tuple: [string, { count: number }];
};

function TypeContract() {
  const state = useDeepSignal<State>({
    profile: { name: "Ada" },
    tasks: [{ id: 1, done: false }],
    tuple: ["first", { count: 0 }],
  });
  const compatible: DeepSignal<State> = state;
  const name: string = state.value.profile.name;

  state.value.profile.name = "Grace";
  state.value.profile.optional = { label: "present" };
  state.value.profile.optional.label = "updated";
  state.value.tasks[0]!.done = true;
  state.value.tasks.push({ id: 2, done: false });
  state.value.tuple[1].count++;
  state.value = {
    profile: { name: "Lin" },
    tasks: [],
    tuple: ["replacement", { count: 1 }],
  };

  // @ts-expect-error nested values retain their declared type.
  state.value.profile.name = 1;
  // @ts-expect-error array element values retain their declared type.
  state.value.tasks.push({ id: "two", done: false });
  // @ts-expect-error optional objects reject undeclared members.
  state.value.profile.optional?.missing;
  // @ts-expect-error tuples retain their element types.
  state.value.tuple[0] = 1;
  // @ts-expect-error root replacements retain the root state shape.
  state.value = { profile: { name: "incomplete" } };

  void [compatible, name];
}

void TypeContract;
