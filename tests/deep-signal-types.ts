import { deepSignal } from "../src/index.js";
import type { DeepSignal, Signal } from "../src/index.js";

type State = {
  user: {
    name: string;
    optional?: { label: string };
  };
  items: Array<{ done: boolean }>;
  tuple: [string, { count: number }];
  map: Map<string, { count: number }>;
  set: Set<string>;
};

const state = deepSignal<State>({
  user: { name: "Ada" },
  items: [{ done: false }],
  tuple: ["first", { count: 0 }],
  map: new Map([["first", { count: 0 }]]),
  set: new Set(["first"]),
});

const deepSignalCompatible: DeepSignal<State> = state;
const signalCompatible: Signal<{ value: number }> = deepSignal({ value: 1 });
const name: string = state.value.user.name;
const firstTupleValue: string = state.value.tuple[0];

state.value.user.name = "Grace";
state.value.items[0]!.done = true;
state.value.tuple[1].count++;
state.value.user.optional = { label: "present" };
state.value.user.optional.label = "updated";
state.value.map = new Map([["replacement", { count: 1 }]]);
state.value.set = new Set(["replacement"]);
state.value = {
  user: { name: "Lin" },
  items: [],
  tuple: ["replacement", { count: 1 }],
  map: new Map(),
  set: new Set(),
};

const mutableMap: Map<string, { count: number }> = state.value.map;
const mutableSet: Set<string> = state.value.set;

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
state.value.map.set("permitted-by-static-type", { count: 1 });
state.value.set.add("permitted-by-static-type");

class NominalBox {
  #brand = true;
  constructor(readonly count: number) {}
}
type NominalState = { box: NominalBox };
const nominal = deepSignal<NominalState>({ box: new NominalBox(1) });
const nominalBox: NominalBox = nominal.value.box;
const nominalSignal: Signal<NominalState> = nominal;

void [signalCompatible, deepSignalCompatible, name, firstTupleValue, mutableMap, mutableSet, nominalBox, nominalSignal];
