import { deepSignal } from "../src/index.js";
import type { DeepSignal, DeepSignalOptions, Signal } from "../src/index.js";

const legacy = deepSignal({ map: new Map<string, number>() });
const compatible: DeepSignal<{ map: Map<string, number> }> = legacy;
const signalCompatible: Signal<{ map: Map<string, number> }> = legacy;
void compatible;
void signalCompatible;

const options: DeepSignalOptions = { collections: "reactive" };
// @ts-expect-error Only the explicitly supported reactive mode is accepted.
const invalidOptions: DeepSignalOptions = { collections: "readonly" };
void invalidOptions;
const map = deepSignal(new Map<string, { count: number }>(), options);
const nested = deepSignal({ set: new Set<object>() }, { collections: "reactive" });
const weakMap = deepSignal(new WeakMap<object, string>(), { collections: "reactive" });
const weakSet = deepSignal(new WeakSet<object>(), { collections: "reactive" });

const entry: { count: number } | undefined = map.value.get("key");
const root: Map<string, { count: number }> = map.peek();
const hasMember: boolean = nested.value.set.has({});
const weakValue: string | undefined = weakMap.value.get({});
const weakHas: boolean = weakSet.value.has({});
void entry;
void root;
void hasMember;
void weakValue;
void weakHas;
