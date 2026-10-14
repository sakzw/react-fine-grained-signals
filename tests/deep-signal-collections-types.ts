import { deepSignal } from "../src/index.js";
import type { DeepSignal, Signal } from "../src/index.js";

const state = deepSignal({ map: new Map<string, number>() });
const compatible: DeepSignal<{ map: Map<string, number> }> = state;
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
const root: Map<string, { count: number }> = map.peek();
const hasMember: boolean = nested.value.set.has({});
const weakValue: string | undefined = weakMap.value.get({});
const weakHas: boolean = weakSet.value.has({});
void entry;
void root;
void hasMember;
void weakValue;
void weakHas;
