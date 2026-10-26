import { deepCollectionSignal, deepSignal, useDeepSignalValue } from "../src/index.js";
import type { DeepCollectionSignal, DeepSignal, Signal } from "../src/index.js";

const state = deepCollectionSignal({ map: new Map<string, number>() });
const compatible: DeepCollectionSignal<{ map: Map<string, number> }> = state;
// @ts-expect-error A DeepSignal is not a Signal: peek() is deep read-only.
const signalCompatible: Signal<{ map: Map<string, number> }> = state;
void compatible;
void signalCompatible;

// @ts-expect-error Collection mode options were removed in v0.3.0.
type RemovedOptions = import("../src/index.js").DeepSignalOptions;
void (undefined as unknown as RemovedOptions);

const map = deepCollectionSignal(new Map<string, { count: number }>());
const nested = deepCollectionSignal({ set: new Set<object>() });
const weakMap = deepCollectionSignal(new WeakMap<object, string>());
const weakSet = deepCollectionSignal(new WeakSet<object>());

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

// deepSignal does not take a collection root; deepCollectionSignal does.
// @ts-expect-error use deepCollectionSignal() for a Map root.
deepSignal(new Map<string, number>());
// @ts-expect-error use deepCollectionSignal() for a Set root.
deepSignal(new Set<string>());
// @ts-expect-error use deepCollectionSignal() for a WeakMap root.
deepSignal(new WeakMap<object, string>());
// @ts-expect-error use deepCollectionSignal() for a WeakSet root.
deepSignal(new WeakSet<object>());
// @ts-expect-error a collection in an explicit union type argument is rejected too.
deepSignal<{ count: number } | Map<string, number>>(new Map());
// Unions of plain objects, and any, are still accepted.
deepSignal<{ kind: "a"; a: number } | { kind: "b"; b: string }>({ kind: "a", a: 1 });
deepSignal({ count: 0 } as any);

// The two kinds of deep signal are distinct types.
const plain = deepSignal({ count: 0 });
// @ts-expect-error a DeepSignal does not track collections, so it is not a DeepCollectionSignal.
export const plainAsCollection: DeepCollectionSignal<{ count: number }> = plain;
// @ts-expect-error a DeepCollectionSignal is not a DeepSignal.
export const collectionAsPlain: DeepSignal<{ count: number }> = deepCollectionSignal({ count: 0 });

// useDeepSignalValue accepts both.
export const fromPlain: number = useDeepSignalValue(plain, (value) => value.count);
export const fromCollection: number = useDeepSignalValue(
  deepCollectionSignal({ items: new Set<string>() }),
  (value) => value.items.size,
);

// A nested Map or Set inside deepSignal is an untracked value. Its type is
// unchanged, so mutating it compiles; the runtime does not notify (see docs).
export const nestedPlain = deepSignal({ tags: new Set<string>() });
nestedPlain.value.tags.add("compiles-but-is-not-tracked");
