import { deepSignal } from "../src/index.js";
import type { DeepSignal, Signal } from "../src/index.js";

const state = deepSignal({ map: new Map<string, number>() });
const compatible: DeepSignal<{ map: Map<string, number> }> = state;
// @ts-expect-error A DeepSignal is not a Signal: peek() is deep read-only.
const signalCompatible: Signal<{ map: Map<string, number> }> = state;
void compatible;
void signalCompatible;

// @ts-expect-error Collection mode options were removed in v0.3.0.
type RemovedOptions = import("../src/index.js").DeepSignalOptions;
void (undefined as unknown as RemovedOptions);

const map = deepSignal(new Map<string, { count: number }>());
const nested = deepSignal({ set: new Set<object>() });
const weakMap = deepSignal(new WeakMap<object, string>());
const weakSet = deepSignal(new WeakSet<object>());

const entry: { count: number } | undefined = map.value.get("key");
const root: ReadonlyMap<string, { readonly count: number }> = map.peek();
// @ts-expect-error peek() exposes a ReadonlyMap, so mutating methods are rejected.
map.peek().set("key", { count: 1 });
// @ts-expect-error peek() entries are read-only.
map.peek().get("key")!.count = 2;
const peekedSet: ReadonlySet<object> = nested.peek().set;
// @ts-expect-error peek() exposes a ReadonlySet.
nested.peek().set.add({});
// @ts-expect-error WeakMap#set is removed from the peek() type.
weakMap.peek().set({}, "x");
// @ts-expect-error WeakSet#add is removed from the peek() type.
weakSet.peek().add({});
const weakPeekValue: string | undefined = weakMap.peek().get({});
void peekedSet;
void weakPeekValue;
const hasMember: boolean = nested.value.set.has({});
const weakValue: string | undefined = weakMap.value.get({});
const weakHas: boolean = weakSet.value.has({});
void entry;
void root;
void hasMember;
void weakValue;
void weakHas;
