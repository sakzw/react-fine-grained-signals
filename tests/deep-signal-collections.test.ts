import { afterEach, describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { batch, deepSignal, effect, untracked } from "../src/index.js";

describe("deepSignal reactive collections", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
  });

  it("keeps the legacy opaque collection contract unless opted in", () => {
    const rawMap = new Map([["a", 1]]);
    const legacy = deepSignal({ map: rawMap });
    expect(legacy.value.map.get("a")).toBe(1);
    expect(() => legacy.value.map.set("b", 2)).toThrow("Map#set()");

    const reactive = deepSignal(rawMap, { collections: "reactive" });
    expect(reactive.value).toBeInstanceOf(Map);
    expect(reactive.value).not.toBe(legacy.value.map);
    expect(reactive.value.set("b", 2)).toBe(reactive.value);
    expect(legacy.value.map.get("b")).toBe(2);
  });

  it("tracks Map keys, values, size and both iteration domains independently", () => {
    const map = deepSignal(new Map([["a", 1], ["b", 2]]), { collections: "reactive" });
    const values: Array<number | undefined> = [];
    const existence: boolean[] = [];
    const sizes: number[] = [];
    const keys: string[][] = [];
    const entries: string[][] = [];
    disposers.push(effect(() => { values.push(map.value.get("a")); }));
    disposers.push(effect(() => { existence.push(map.value.has("a")); }));
    disposers.push(effect(() => { sizes.push(map.value.size); }));
    disposers.push(effect(() => { keys.push([...map.value.keys()]); }));
    disposers.push(effect(() => { entries.push([...map.value].map(([key, value]) => `${key}=${value}`)); }));

    map.value.set("a", 3);
    expect(values).toEqual([1, 3]);
    expect(existence).toEqual([true]);
    expect(sizes).toEqual([2]);
    expect(keys).toEqual([["a", "b"]]);
    expect(entries).toEqual([["a=1", "b=2"], ["a=3", "b=2"]]);

    map.value.set("c", 4);
    expect(values).toEqual([1, 3]);
    expect(existence).toEqual([true]);
    expect(sizes).toEqual([2, 3]);
    expect(keys.at(-1)).toEqual(["a", "b", "c"]);
    expect(entries.at(-1)).toEqual(["a=3", "b=2", "c=4"]);

    const runCounts = [values.length, existence.length, sizes.length, keys.length, entries.length];
    map.value.set("c", 4);
    expect([values.length, existence.length, sizes.length, keys.length, entries.length]).toEqual(runCounts);
    map.value.delete("a");
    expect(values).toEqual([1, 3, undefined]);
    expect(existence).toEqual([true, false]);
    expect(sizes.at(-1)).toBe(2);
    expect(keys.at(-1)).toEqual(["b", "c"]);
    expect(entries.at(-1)).toEqual(["b=2", "c=4"]);
  });

  it("normalizes raw and proxy Map keys and Set members while wrapping iteration values", () => {
    const key = { id: 1 };
    const value = { count: 1 };
    const state = deepSignal({ map: new Map([[key, value]]), set: new Set([key]) }, {
      collections: "reactive",
    });
    const proxyKey = [...state.value.map.keys()][0]!;
    const proxySetMember = [...state.value.set][0]!;

    expect(proxyKey).not.toBe(key);
    expect(proxySetMember).toBe(proxyKey);
    expect(state.value.map.get(key)).toBe(state.value.map.get(proxyKey));
    expect(state.value.map.get(proxyKey)?.count).toBe(1);
    expect(state.value.set.has(key)).toBe(true);
    expect(state.value.set.has(proxySetMember)).toBe(true);

    state.value.map.set(proxyKey, { count: 2 });
    expect(state.value.map.size).toBe(1);
    expect(state.peek().map.has(proxyKey)).toBe(false);
    expect(state.peek().map.has(key)).toBe(true);
    expect(state.value.set.delete(proxySetMember)).toBe(true);
    expect(state.peek().set.has(key)).toBe(false);
  });

  it("rejects collection subclasses and cross-realm collections in reactive mode", () => {
    class CustomMap extends Map<string, number> {}
    const crossRealmMap = runInNewContext("new Map([['a', 1]])") as Map<string, number>;
    expect(() => deepSignal(new CustomMap(), { collections: "reactive" })).toThrow(/same-realm/);
    expect(() => deepSignal({ map: crossRealmMap }, { collections: "reactive" })).toThrow(/same-realm/);
  });

  it("rejects prototype mutation on reactive collection proxies", () => {
    const map = deepSignal(new Map([["a", 1]]), { collections: "reactive" });

    expect(() => Reflect.set(map.value, "extra", 1)).toThrow(/own properties/);
    expect(() => Reflect.deleteProperty(map.value, "a")).toThrow(/own properties/);
    expect(() => Object.defineProperty(map.value, "extra", { value: 1 })).toThrow(/property descriptors/);
    expect(() => Object.preventExtensions(map.value)).toThrow(/must remain extensible/);
    expect(() => Object.setPrototypeOf(map.value, null)).toThrow(/prototype mutation/);
    expect(map.value).toBeInstanceOf(Map);
    expect(map.value.get("a")).toBe(1);
  });

  it("rejects Map key collisions caused by normalizing this runtime's proxy", () => {
    const source = deepSignal({ key: { id: 1 } });
    const rawKey = source.peek().key;
    const proxyKey = source.value.key;
    const colliding = new Map< object, number>([[rawKey, 1], [proxyKey, 2]]);
    expect(() => deepSignal(colliding, { collections: "reactive" })).toThrow(/collide after proxy normalization/);
  });

  it("wraps nested collection values and preserves aliases and cycles", () => {
    const shared = { count: 0 };
    const map = new Map<string, { child: typeof shared }>([["entry", { child: shared }]]);
    const raw: { map: typeof map; first: typeof shared; second: typeof shared; self?: unknown } = {
      map,
      first: shared,
      second: shared,
    };
    raw.self = raw;
    const state = deepSignal(raw, { collections: "reactive" });
    const root = state.value;

    expect(root.first).toBe(root.second);
    expect(root.map.get("entry")?.child).toBe(root.first);
    expect(root.self).toBe(root);
  });

  it("tracks WeakMap and WeakSet operations only by object key", () => {
    const key = {};
    const weakMap = deepSignal(new WeakMap<object, { count: number }>(), {
      collections: "reactive",
    });
    const weakSet = deepSignal(new WeakSet<object>(), { collections: "reactive" });
    expect("clear" in weakMap.value).toBe(false);
    expect("clear" in weakSet.value).toBe(false);
    const seen: Array<number | undefined> = [];
    let hasRuns = 0;
    disposers.push(effect(() => { seen.push(weakMap.value.get(key)?.count); }));
    disposers.push(effect(() => { weakSet.value.has(key); hasRuns++; }));

    weakMap.value.set(key, { count: 1 });
    expect(seen).toEqual([undefined, 1]);
    expect(weakMap.value.get(key)?.count).toBe(1);
    expect(weakSet.value.add(key)).toBe(weakSet.value);
    expect(hasRuns).toBe(2);
    weakSet.value.add(key);
    expect(hasRuns).toBe(2);
    expect(weakMap.value.delete(key)).toBe(true);
    expect(seen).toEqual([undefined, 1, undefined]);
    expect(weakSet.value.delete(key)).toBe(true);
    expect(hasRuns).toBe(3);
  });

  it("tracks reactive Set operands used by native Set composition methods", () => {
    type SetWithIsSubsetOf = Set<unknown> & {
      isSubsetOf?: (other: ReadonlySet<unknown>) => boolean;
    };
    if (typeof (Set.prototype as SetWithIsSubsetOf).isSubsetOf !== "function") return;
    const left = deepSignal(new Set([1]), { collections: "reactive" });
    const right = deepSignal(new Set([1]), { collections: "reactive" });
    const results: boolean[] = [];
    disposers.push(effect(() => { results.push((left.value as SetWithIsSubsetOf).isSubsetOf!(right.value)); }));

    right.value.add(2);
    expect(results).toEqual([true, true]);
  });

  it("batches collection changes and leaves untracked reads unsubscribed", () => {
    const state = deepSignal({ map: new Map<string, number>() }, { collections: "reactive" });
    let runs = 0;
    disposers.push(effect(() => { state.value.map.get("a"); runs++; }));

    untracked(() => state.value.map.get("a"));
    batch(() => {
      state.value.map.set("a", 1);
      state.value.map.set("a", 2);
    });
    expect(runs).toBe(2);
  });
});
